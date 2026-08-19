import { afterEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'

import { createResumableUploadClient } from '../src/client.js'
import { UploadClientError } from '../src/errors.js'
import { MemoryUploadCheckpointStore } from '../src/memory-store.js'
import { createBlobUploadSource } from '../src/source.js'
import type {
  AppendRemoteChunkInput,
  CreateRemoteUploadInput,
  RemoteUploadState,
  SleepFunction,
  TusTransport,
  UploadCheckpoint,
  UploadSource,
  UploadTask,
  UploadTaskState,
} from '../src/types.js'

const checkpointId = 'local-upload-1'
const uploadUrl = 'https://uploads.example.test/uploads/remote-1'
const now = new Date('2026-08-19T10:00:00.000Z')

describe('resumable upload client', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('creates, checksums, persists, and completes multiple chunks', async () => {
    const harness = createHarness({ chunkSize: 3 })
    const source = sourceFrom('abcdefgh', 'file-a')
    const task = await harness.client.create({
      metadata: [{ key: 'filename', value: new TextEncoder().encode('demo.txt') }],
      source,
    })
    const states: UploadTaskState[] = []
    const unsubscribe = task.subscribe((state) => states.push(state))
    const completed = await task.start()
    unsubscribe()

    expect(completed).toMatchObject({
      confirmedOffset: 8,
      status: 'completed',
      totalBytes: 8,
      uploadUrl,
    })
    expect(harness.transport.appendOffsets).toEqual([0, 3, 6])
    expect(harness.transport.appendBodies).toEqual(['abc', 'def', 'gh'])
    expect(harness.transport.checksumLengths).toEqual([32, 32, 32])
    expect(harness.transport.createdMetadata[0]).toMatchObject({ key: 'filename' })
    expect(states.map(({ confirmedOffset }) => confirmedOffset)).toContain(3)
    expect(await harness.store.get(checkpointId)).toBeNull()
  })

  it('reconciles a persisted checkpoint with the authoritative remote offset', async () => {
    const harness = createHarness({ chunkSize: 3, remoteOffset: 6, size: 8 })
    const source = sourceFrom('abcdefgh', 'file-a')
    await harness.store.put(checkpoint({ confirmedOffset: 3, size: 8 }))

    const task = await harness.client.resume(checkpointId, source)
    await task.start()

    expect(harness.transport.headCalls).toBe(1)
    expect(harness.transport.appendOffsets).toEqual([6])
    expect(task.state).toMatchObject({ confirmedOffset: 8, status: 'completed' })
  })

  it('uses HEAD after a lost PATCH response and never sends the confirmed chunk twice', async () => {
    const harness = createHarness({ chunkSize: 3 })
    harness.transport.appendBehaviors.push('commit-then-network-error')
    const task = await harness.client.create({ source: sourceFrom('abcdef', 'file-a') })

    await task.start()

    expect(harness.transport.appendOffsets).toEqual([0, 3])
    expect(harness.transport.headCalls).toBe(1)
    expect(harness.delays).toEqual([])
  })

  it('retries an unconfirmed chunk only after HEAD reports the same offset', async () => {
    const harness = createHarness({ chunkSize: 3 })
    harness.transport.appendBehaviors.push('network-error')
    const task = await harness.client.create({ source: sourceFrom('abc', 'file-a') })

    await task.start()

    expect(harness.transport.appendOffsets).toEqual([0, 0])
    expect(harness.transport.headCalls).toBe(1)
    expect(harness.delays).toEqual([500])
  })

  it('honors Retry-After without applying the exponential delay cap', async () => {
    const harness = createHarness({ chunkSize: 3 })
    harness.transport.appendBehaviors.push(
      new UploadClientError({
        code: 'protocol_error',
        message: 'locked',
        retryAfterMs: 30_000,
        retryable: true,
        status: 423,
      }),
    )
    const task = await harness.client.create({ source: sourceFrom('abc', 'file-a') })

    await task.start()

    expect(harness.delays).toEqual([30_000])
  })

  it('pauses during retry backoff and keeps a restart-safe checkpoint', async () => {
    let enteredSleep: (() => void) | null = null
    const sleepStarted = new Promise<void>((resolve) => {
      enteredSleep = resolve
    })
    const sleep: SleepFunction = (_delay, signal) =>
      new Promise((_resolve, reject) => {
        enteredSleep?.()
        signal.addEventListener('abort', () => reject(abortError(signal)), { once: true })
      })
    const harness = createHarness({ sleep })
    harness.transport.appendBehaviors.push('network-error')
    const task = await harness.client.create({ source: sourceFrom('abc', 'file-a') })
    const running = task.start()
    await sleepStarted

    task.pause()
    await expect(running).resolves.toMatchObject({ status: 'paused' })
    expect(await harness.store.get(checkpointId)).toMatchObject({
      confirmedOffset: 0,
      phase: 'paused',
      uploadUrl,
    })
  })

  it('resumes a failed remote task but never blindly retries ambiguous creation', async () => {
    const remoteHarness = createHarness()
    await remoteHarness.store.put(checkpoint({ phase: 'failed', size: 3 }))
    const remoteTask = await remoteHarness.client.resume(checkpointId, sourceFrom('abc', 'file-a'))
    await expect(remoteTask.start()).resolves.toMatchObject({ status: 'completed' })

    const creationHarness = createHarness()
    creationHarness.transport.createError = retryableNetworkError()
    const creationTask = await creationHarness.client.create({
      source: sourceFrom('abc', 'file-a'),
    })
    await expect(creationTask.start()).rejects.toMatchObject({ code: 'network_error' })
    expect(creationHarness.transport.createCalls).toBe(1)
    await expect(creationTask.start()).rejects.toMatchObject({ code: 'network_error' })
    expect(creationHarness.transport.createCalls).toBe(1)
  })

  it('marks an interrupted creation as ambiguous instead of creating a duplicate', async () => {
    const pauseHarness = createHarness()
    pauseHarness.transport.waitDuringCreate = true
    const pauseTask = await pauseHarness.client.create({
      source: sourceFrom('abc', 'file-a'),
    })
    const pauseRunning = pauseTask.start()
    await waitUntil(() => pauseHarness.transport.createCalls === 1)
    pauseTask.pause()
    await expect(pauseRunning).resolves.toMatchObject({
      error: { code: 'creation_ambiguous' },
      status: 'failed',
    })
    await expect(pauseTask.start()).rejects.toMatchObject({ code: 'creation_ambiguous' })
    expect(pauseHarness.transport.createCalls).toBe(1)

    const cancelHarness = createHarness()
    cancelHarness.transport.waitDuringCreate = true
    const cancelTask = await cancelHarness.client.create({
      source: sourceFrom('abc', 'file-a'),
    })
    const cancelRunning = cancelTask.start()
    await waitUntil(() => cancelHarness.transport.createCalls === 1)
    await expect(cancelTask.cancel()).rejects.toMatchObject({ code: 'creation_ambiguous' })
    await expect(cancelRunning).resolves.toMatchObject({ status: 'failed' })
    expect(await cancelHarness.store.get(checkpointId)).toMatchObject({
      lastErrorCode: 'creation_ambiguous',
      phase: 'failed',
    })
  })

  it('rejects mismatched, missing, and corrupt persisted sources', async () => {
    const harness = createHarness()
    await harness.store.put(checkpoint({ size: 3 }))

    await expect(
      harness.client.resume(checkpointId, sourceFrom('xyz', 'different-file')),
    ).rejects.toMatchObject({ code: 'source_mismatch' })
    await expect(
      harness.client.resume('missing', sourceFrom('abc', 'file-a')),
    ).rejects.toMatchObject({ code: 'checkpoint_not_found' })

    await harness.store.put(checkpoint({ confirmedOffset: 4, size: 3 }))
    await expect(
      harness.client.resume(checkpointId, sourceFrom('abc', 'file-a')),
    ).rejects.toMatchObject({ code: 'invalid_checkpoint' })
  })

  it('fails safely when the server length or offset contradicts the source', async () => {
    const lengthHarness = createHarness({ remoteLength: 4, size: 3 })
    await lengthHarness.store.put(checkpoint({ size: 3 }))
    const lengthTask = await lengthHarness.client.resume(checkpointId, sourceFrom('abc', 'file-a'))
    await expect(lengthTask.start()).rejects.toMatchObject({ code: 'source_mismatch' })

    const offsetHarness = createHarness({ remoteOffset: 2, size: 3 })
    await offsetHarness.store.put(checkpoint({ confirmedOffset: 3, size: 3 }))
    const offsetTask = await offsetHarness.client.resume(checkpointId, sourceFrom('abc', 'file-a'))
    await expect(offsetTask.start()).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('keeps terminal errors inspectable in the checkpoint', async () => {
    const harness = createHarness()
    harness.transport.appendBehaviors.push(
      new UploadClientError({
        code: 'upload_expired',
        message: 'expired',
        status: 410,
      }),
    )
    const task = await harness.client.create({ source: sourceFrom('abc', 'file-a') })

    await expect(task.start()).rejects.toMatchObject({ code: 'upload_expired' })
    expect(task.state).toMatchObject({ error: { code: 'upload_expired' }, status: 'failed' })
    expect(await harness.store.get(checkpointId)).toMatchObject({
      lastErrorCode: 'upload_expired',
      phase: 'failed',
    })
  })

  it('exhausts bounded append and HEAD retry budgets', async () => {
    const appendHarness = createHarness({ maximumAttempts: 2 })
    appendHarness.transport.appendBehaviors.push('network-error', 'network-error')
    const appendTask = await appendHarness.client.create({
      source: sourceFrom('abc', 'file-a'),
    })
    await expect(appendTask.start()).rejects.toMatchObject({ code: 'retry_exhausted' })
    expect(appendHarness.transport.headCalls).toBe(2)

    const headHarness = createHarness({ maximumAttempts: 2 })
    headHarness.transport.headBehaviors.push(retryableNetworkError(), retryableNetworkError())
    await headHarness.store.put(checkpoint({ size: 3 }))
    const headTask = await headHarness.client.resume(checkpointId, sourceFrom('abc', 'file-a'))
    await expect(headTask.start()).rejects.toMatchObject({ code: 'retry_exhausted' })
    expect(headHarness.delays).toEqual([500])
  })

  it('retries failed recovery HEAD requests and stops on terminal reconciliation errors', async () => {
    const retryHarness = createHarness()
    retryHarness.transport.appendBehaviors.push('network-error')
    retryHarness.transport.headBehaviors.push(retryableNetworkError())
    const retryTask = await retryHarness.client.create({ source: sourceFrom('abc', 'file-a') })
    await retryTask.start()
    expect(retryHarness.transport.headCalls).toBe(2)
    expect(retryHarness.delays).toEqual([500, 500])

    const terminalHarness = createHarness()
    terminalHarness.transport.appendBehaviors.push('network-error')
    terminalHarness.transport.headBehaviors.push(
      new UploadClientError({ code: 'upload_expired', message: 'expired' }),
    )
    const terminalTask = await terminalHarness.client.create({
      source: sourceFrom('abc', 'file-a'),
    })
    await expect(terminalTask.start()).rejects.toMatchObject({ code: 'upload_expired' })
  })

  it('rejects partial PATCH acknowledgements and missing upload URLs', async () => {
    const partialHarness = createHarness()
    partialHarness.transport.appendOffsetOverride = 2
    const partialTask = await partialHarness.client.create({
      source: sourceFrom('abc', 'file-a'),
    })
    await expect(partialTask.start()).rejects.toMatchObject({ code: 'invalid_response' })

    const missingUrlHarness = createHarness()
    missingUrlHarness.transport.remoteUrl = ''
    const missingUrlTask = await missingUrlHarness.client.create({
      source: sourceFrom('abc', 'file-a'),
    })
    await expect(missingUrlTask.start()).rejects.toMatchObject({ code: 'invalid_checkpoint' })
  })

  it('pauses requests that are currently inside PATCH or reconciliation', async () => {
    const appendHarness = createHarness()
    appendHarness.transport.appendBehaviors.push('wait-for-abort')
    const appendTask = await appendHarness.client.create({
      source: sourceFrom('abc', 'file-a'),
    })
    const appendRunning = appendTask.start()
    await waitUntil(() => appendHarness.transport.appendOffsets.length === 1)
    appendTask.pause()
    await expect(appendRunning).resolves.toMatchObject({ status: 'paused' })

    const headHarness = createHarness()
    headHarness.transport.headBehaviors.push('wait-for-abort')
    await headHarness.store.put(checkpoint({ size: 3 }))
    const headTask = await headHarness.client.resume(checkpointId, sourceFrom('abc', 'file-a'))
    const headRunning = headTask.start()
    await waitUntil(() => headHarness.transport.headCalls === 1)
    headTask.pause()
    await expect(headRunning).resolves.toMatchObject({ status: 'paused' })
  })

  it('cancels remote and local state while tolerating an already-gone upload', async () => {
    const harness = createHarness()
    await harness.store.put(checkpoint({ size: 3 }))
    const task = await harness.client.resume(checkpointId, sourceFrom('abc', 'file-a'))
    harness.transport.terminateError = new UploadClientError({
      code: 'remote_not_found',
      message: 'gone',
      status: 404,
    })

    await task.cancel()

    expect(task.state.status).toBe('canceled')
    expect(harness.transport.terminateCalls).toBe(1)
    expect(await harness.store.get(checkpointId)).toBeNull()
  })

  it('retains the checkpoint when remote termination cannot be confirmed', async () => {
    const harness = createHarness()
    await harness.store.put(checkpoint({ size: 3 }))
    const task = await harness.client.resume(checkpointId, sourceFrom('abc', 'file-a'))
    harness.transport.terminateError = retryableNetworkError()

    await expect(task.cancel()).rejects.toMatchObject({ code: 'network_error' })
    expect(task.state.status).toBe('failed')
    expect(await harness.store.get(checkpointId)).not.toBeNull()
  })

  it('terminates dormant checkpoints and exposes pending uploads newest first', async () => {
    const harness = createHarness()
    await harness.store.put(checkpoint({ id: 'older', updatedAt: '2026-08-19T09:00:00.000Z' }))
    await harness.store.put(checkpoint({ id: 'newer', updatedAt: '2026-08-19T11:00:00.000Z' }))
    expect((await harness.client.list()).map(({ id }) => id)).toEqual(['newer', 'older'])

    await harness.client.terminate('older')
    expect(harness.transport.terminateCalls).toBe(1)
    expect(await harness.store.get('older')).toBeNull()
    await expect(harness.client.terminate('missing')).rejects.toMatchObject({
      code: 'checkpoint_not_found',
    })
  })

  it('delegates termination to an active task and handles dormant remote outcomes', async () => {
    const activeHarness = createHarness()
    const activeTask = await activeHarness.client.create({ source: sourceFrom('abc', 'file-a') })
    await activeHarness.client.terminate(activeTask.id)
    expect(activeTask.state.status).toBe('canceled')

    for (const code of ['remote_not_found', 'upload_expired'] as const) {
      const goneHarness = createHarness()
      await goneHarness.store.put(checkpoint())
      goneHarness.transport.terminateError = new UploadClientError({ code, message: 'gone' })
      await expect(goneHarness.client.terminate(checkpointId)).resolves.toBeUndefined()
      expect(await goneHarness.store.get(checkpointId)).toBeNull()
    }

    const failedHarness = createHarness()
    await failedHarness.store.put(checkpoint())
    failedHarness.transport.terminateError = retryableNetworkError()
    await expect(failedHarness.client.terminate(checkpointId)).rejects.toMatchObject({
      code: 'network_error',
    })
    expect(await failedHarness.store.get(checkpointId)).not.toBeNull()
  })

  it('deduplicates active task instances and concurrent start calls', async () => {
    const harness = createHarness()
    const source = sourceFrom('abc', 'file-a')
    const task = await harness.client.create({ source })
    const sameTask = await harness.client.resume(checkpointId, source)

    expect(sameTask).toBe(task)
    await expect(
      harness.client.resume(checkpointId, sourceFrom('xyz', 'different')),
    ).rejects.toMatchObject({ code: 'source_mismatch' })
    const first = task.start()
    const second = task.start()
    expect(second).toBe(first)
    await first
    expect(harness.transport.createCalls).toBe(1)
    await expect(task.start()).resolves.toMatchObject({ status: 'completed' })
  })

  it('completes zero-byte files without PATCH and isolates listener failures', async () => {
    const harness = createHarness({ size: 0 })
    const task = await harness.client.create({ source: sourceFrom('', 'empty') })
    task.subscribe(() => {
      throw new Error('UI listener failed')
    })

    await expect(task.start()).resolves.toMatchObject({ confirmedOffset: 0, status: 'completed' })
    expect(harness.transport.appendOffsets).toEqual([])
    task.pause()
    await task.cancel()
    expect(task.state.status).toBe('completed')
  })

  it('cancels an in-flight PATCH through the client facade', async () => {
    const harness = createHarness()
    harness.transport.appendBehaviors.push('wait-for-abort')
    const task = await harness.client.create({ source: sourceFrom('abc', 'file-a') })
    const running = task.start()
    await waitUntil(() => harness.transport.appendOffsets.length === 1)

    await harness.client.terminate(task.id)
    await expect(running).resolves.toBeDefined()
    expect(task.state.status).toBe('canceled')
    await expect(task.start()).resolves.toMatchObject({ status: 'canceled' })
  })

  it('validates client configuration, generated IDs, clocks, sources, and randomness', async () => {
    const store = new MemoryUploadCheckpointStore()
    const transport = new FakeTransport(3)
    expect(() =>
      createResumableUploadClient({
        checkpointStore: store,
        chunkSize: 0,
        endpoint: '/uploads',
        transport,
      }),
    ).toThrow('chunkSize')
    expect(() =>
      createResumableUploadClient({
        checkpointStore: store,
        endpoint: '/uploads',
        retry: { baseDelayMs: 10, maximumDelayMs: 1 },
        transport,
      }),
    ).toThrow('maximumDelayMs')
    expect(() =>
      createResumableUploadClient({
        checkpointStore: store,
        endpoint: '/uploads',
        retry: { jitterRatio: 2 },
        transport,
      }),
    ).toThrow('jitterRatio')
    expect(() =>
      createResumableUploadClient({
        checkpointStore: store,
        endpoint: '/uploads',
        retry: { maximumAttempts: 0 },
        transport,
      }),
    ).toThrow('maximumAttempts')

    const badId = createHarness({ createId: () => '' })
    await expect(badId.client.create({ source: sourceFrom('abc', 'file-a') })).rejects.toThrow(
      'identifiers',
    )
    const badClock = createHarness({ clock: () => new Date(Number.NaN) })
    await expect(badClock.client.create({ source: sourceFrom('abc', 'file-a') })).rejects.toThrow(
      'valid Date',
    )
    await expect(
      createHarness().client.create({
        source: { fingerprint: '', size: -1, slice: () => new Blob() },
      }),
    ).rejects.toBeInstanceOf(TypeError)
    await expect(
      createHarness().client.create({
        source: { fingerprint: 'x'.repeat(1_025), size: 0, slice: () => new Blob() },
      }),
    ).rejects.toBeInstanceOf(TypeError)

    const randomHarness = createHarness({ random: () => 2 })
    randomHarness.transport.appendBehaviors.push('network-error')
    const task = await randomHarness.client.create({ source: sourceFrom('abc', 'file-a') })
    await expect(task.start()).rejects.toThrow('random')

    const source = sourceFrom('abc', 'file-a')
    vi.stubGlobal('crypto', undefined)
    const missingCrypto = createResumableUploadClient({
      checkpointStore: store,
      endpoint: '/uploads',
      transport,
    })
    await expect(missingCrypto.create({ source })).rejects.toThrow('randomUUID')
  })

  it('uses default browser dependencies and abortable retry sleep', async () => {
    const store = new MemoryUploadCheckpointStore()
    const recorder: Array<{ init?: RequestInit }> = []
    const fetch = vi.fn((_: RequestInfo | URL, init?: RequestInit) => {
      recorder.push({ ...(init ? { init } : {}) })
      return Promise.resolve(
        new Response(null, {
          headers: { Location: '/uploads/zero', 'Tus-Resumable': '1.0.0' },
          status: 201,
        }),
      )
    })
    vi.stubGlobal('fetch', fetch)
    const defaults = createResumableUploadClient({ checkpointStore: store, endpoint: '/uploads' })
    const task = await defaults.create({ source: sourceFrom('', 'empty') })
    expect(task.id).toMatch(/^[0-9a-f-]{36}$/u)
    await expect(task.start()).resolves.toMatchObject({ status: 'completed' })
    expect(recorder).toHaveLength(1)

    const retryStore = new MemoryUploadCheckpointStore()
    const retryTransport = new FakeTransport(3)
    retryTransport.appendBehaviors.push('network-error')
    const retryClient = createResumableUploadClient({
      checkpointStore: retryStore,
      chunkSize: 3,
      createId: () => checkpointId,
      endpoint: '/uploads',
      retry: { baseDelayMs: 1, jitterRatio: 0, maximumAttempts: 2 },
      transport: retryTransport,
    })
    const retryTask = await retryClient.create({ source: sourceFrom('abc', 'file-a') })
    const running = retryTask.start()
    await waitUntil(() => retryTask.state.status === 'retrying')
    await expect(running).resolves.toMatchObject({ status: 'completed' })

    retryTransport.remoteOffset = 0
    retryTransport.appendBehaviors.push('network-error')
    const pauseClient = createResumableUploadClient({
      checkpointStore: retryStore,
      chunkSize: 3,
      createId: () => checkpointId,
      endpoint: '/uploads',
      retry: { baseDelayMs: 1_000, jitterRatio: 0, maximumAttempts: 2 },
      transport: retryTransport,
    })
    const pauseTask = await pauseClient.create({
      source: sourceFrom('abc', 'second-file'),
    })
    const pauseRunning = pauseTask.start()
    await waitUntil(() => pauseTask.state.status === 'retrying')
    pauseTask.pause()
    await expect(pauseRunning).resolves.toMatchObject({ status: 'paused' })
  })

  it('aborts immediately when a source pauses its own task before hashing', async () => {
    const harness = createHarness()
    const taskReference: { current: UploadTask | null } = { current: null }
    const source: UploadSource = {
      fingerprint: 'self-pausing',
      size: 1,
      slice: () => {
        taskReference.current?.pause()
        return new Blob(['x'])
      },
    }
    const task = await harness.client.create({ source })
    taskReference.current = task
    await expect(task.start()).resolves.toMatchObject({ status: 'paused' })
  })

  it('handles a signal already aborted while entering default retry sleep', async () => {
    const store = new MemoryUploadCheckpointStore()
    const transport = new FakeTransport(3)
    transport.appendBehaviors.push('network-error')
    const taskReference: { current: UploadTask | null } = { current: null }
    const client = createResumableUploadClient({
      checkpointStore: store,
      createId: () => checkpointId,
      endpoint: '/uploads',
      random: () => {
        taskReference.current?.pause()
        return 0.5
      },
      transport,
    })
    const task = await client.create({ source: sourceFrom('abc', 'file-a') })
    taskReference.current = task
    await expect(task.start()).resolves.toMatchObject({ status: 'paused' })
  })

  it('never PATCHes below the server offset after ambiguous commits', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.boolean(), { maxLength: 8, minLength: 1 }), async (failures) => {
        const content = 'x'.repeat(failures.length)
        const harness = createHarness({ chunkSize: 1, size: content.length })
        harness.transport.appendBehaviors.push(
          ...failures.map(
            (afterCommit) =>
              (afterCommit ? 'commit-then-network-error' : 'success') as AppendBehavior,
          ),
        )
        const task = await harness.client.create({ source: sourceFrom(content, 'property-file') })
        await task.start()
        expect(harness.transport.offsetViolations).toEqual([])
      }),
      { numRuns: 25 },
    )
  })
})

interface HarnessOptions {
  readonly chunkSize?: number
  readonly clock?: () => Date
  readonly createId?: () => string
  readonly maximumAttempts?: number
  readonly random?: () => number
  readonly remoteLength?: number
  readonly remoteOffset?: number
  readonly size?: number
  readonly sleep?: SleepFunction
}

function createHarness(options: HarnessOptions = {}) {
  const size = options.size ?? 3
  const store = new MemoryUploadCheckpointStore()
  const transport = new FakeTransport(size, options.remoteOffset ?? 0, options.remoteLength ?? size)
  const delays: number[] = []
  const sleep: SleepFunction =
    options.sleep ??
    ((delay, signal) => {
      if (signal.aborted) return Promise.reject(abortError(signal))
      delays.push(delay)
      return Promise.resolve()
    })
  const client = createResumableUploadClient({
    checkpointStore: store,
    chunkSize: options.chunkSize ?? 3,
    clock: options.clock ?? (() => now),
    createId: options.createId ?? (() => checkpointId),
    endpoint: 'https://uploads.example.test/uploads',
    random: options.random ?? (() => 0.5),
    retry: {
      baseDelayMs: 500,
      jitterRatio: 0,
      maximumAttempts: options.maximumAttempts ?? 3,
      maximumDelayMs: 2_000,
    },
    sleep,
    transport,
  })
  return { client, delays, store, transport }
}

type AppendBehavior =
  'commit-then-network-error' | 'network-error' | 'success' | 'wait-for-abort' | UploadClientError
type HeadBehavior = 'wait-for-abort' | UploadClientError

class FakeTransport implements TusTransport {
  public appendBehaviors: AppendBehavior[] = []
  public appendBodies: string[] = []
  public appendOffsetOverride: number | null = null
  public appendOffsets: number[] = []
  public checksumLengths: number[] = []
  public createCalls = 0
  public createError: UploadClientError | null = null
  public createdMetadata: CreateRemoteUploadInput['metadata'] = []
  public headBehaviors: HeadBehavior[] = []
  public headCalls = 0
  public offsetViolations: number[] = []
  public remoteLength: number
  public remoteOffset: number
  public remoteUrl = uploadUrl
  public terminateCalls = 0
  public terminateError: UploadClientError | null = null
  public waitDuringCreate = false

  public constructor(
    private readonly sourceSize: number,
    remoteOffset = 0,
    remoteLength = sourceSize,
  ) {
    this.remoteOffset = remoteOffset
    this.remoteLength = remoteLength
  }

  public create(input: CreateRemoteUploadInput): Promise<RemoteUploadState> {
    this.createCalls += 1
    this.createdMetadata = input.metadata
    if (this.createError) return Promise.reject(this.createError)
    if (this.waitDuringCreate) return rejectWhenAborted(input.signal)
    this.remoteLength = input.size
    this.remoteOffset = 0
    return Promise.resolve(this.state())
  }

  public head(_uploadUrl: string, _signal: AbortSignal): Promise<RemoteUploadState> {
    this.headCalls += 1
    const behavior = this.headBehaviors.shift()

    if (behavior === 'wait-for-abort') {
      return rejectWhenAborted(_signal)
    }

    return behavior ? Promise.reject(behavior) : Promise.resolve(this.state())
  }

  public async append(input: AppendRemoteChunkInput): Promise<RemoteUploadState> {
    if (input.offset < this.remoteOffset) this.offsetViolations.push(input.offset)
    this.appendOffsets.push(input.offset)
    this.appendBodies.push(await input.body.text())
    this.checksumLengths.push(input.checksum.byteLength)
    const behavior = this.appendBehaviors.shift() ?? 'success'

    if (behavior instanceof UploadClientError) throw behavior
    if (behavior === 'network-error') throw retryableNetworkError()
    if (behavior === 'wait-for-abort') return rejectWhenAborted(input.signal)

    this.remoteOffset = this.appendOffsetOverride ?? input.offset + input.body.size
    this.appendOffsetOverride = null

    if (behavior === 'commit-then-network-error') throw retryableNetworkError()
    return this.state()
  }

  public terminate(_uploadUrl: string, _signal: AbortSignal): Promise<void> {
    this.terminateCalls += 1
    return this.terminateError ? Promise.reject(this.terminateError) : Promise.resolve()
  }

  private state(): RemoteUploadState {
    return {
      expiresAt: '2026-08-20T10:00:00.000Z',
      length: this.remoteLength,
      offset: this.remoteOffset,
      uploadUrl: this.remoteUrl,
    }
  }
}

function sourceFrom(content: string, fingerprint: string): UploadSource {
  return createBlobUploadSource(new Blob([content]), fingerprint)
}

function checkpoint(overrides: Partial<UploadCheckpoint> = {}): UploadCheckpoint {
  return {
    confirmedOffset: 0,
    createdAt: now.toISOString(),
    expiresAt: '2026-08-20T10:00:00.000Z',
    id: checkpointId,
    lastErrorCode: null,
    metadata: [],
    phase: 'active',
    size: 3,
    sourceFingerprint: 'file-a',
    updatedAt: now.toISOString(),
    uploadUrl,
    ...overrides,
  }
}

function retryableNetworkError(): UploadClientError {
  return new UploadClientError({
    code: 'network_error',
    message: 'connection lost',
    retryable: true,
  })
}

function rejectWhenAborted<T>(signal: AbortSignal): Promise<T> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(abortError(signal)), { once: true })
  })
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('aborted', 'AbortError')
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }

  throw new Error('Condition was not reached')
}
