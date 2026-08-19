// @vitest-environment jsdom

import { StrictMode } from 'react'
import { renderToString } from 'react-dom/server'
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type {
  CreateUploadTaskInput,
  ResumableUploadClient,
  UploadCheckpoint,
  UploadSource,
  UploadTask,
  UploadTaskListener,
  UploadTaskState,
} from '@resumable-upload-kit/client'

import { usePendingUploads } from '../src/use-pending-uploads.js'
import { useResumableUpload } from '../src/use-resumable-upload.js'
import { useUploadTask } from '../src/use-upload-task.js'

const source: UploadSource = {
  fingerprint: 'document:3',
  size: 3,
  slice: (start, end) => new Blob(['abc'.slice(start, end)]),
}

describe('useUploadTask', () => {
  it('tracks immutable task snapshots and changes subscriptions with the task', () => {
    const first = new FakeUploadTask('first')
    const second = new FakeUploadTask('second')
    const initialProps: { task: UploadTask | null } = { task: first }
    const { result, rerender, unmount } = renderHook(
      ({ task }: { task: UploadTask | null }) => useUploadTask(task),
      { initialProps },
    )

    expect(result.current).toMatchObject({ id: 'first', status: 'paused' })
    expect(first.listenerCount).toBe(1)

    act(() => first.emit({ confirmedOffset: 2, status: 'uploading' }))
    expect(result.current).toMatchObject({ confirmedOffset: 2, status: 'uploading' })

    rerender({ task: second })
    expect(first.listenerCount).toBe(0)
    expect(second.listenerCount).toBe(1)
    expect(result.current).toMatchObject({ id: 'second' })

    rerender({ task: null })
    expect(second.listenerCount).toBe(0)
    expect(result.current).toBeNull()
    unmount()
  })

  it('keeps one live subscription in StrictMode and never starts a task implicitly', () => {
    const task = new FakeUploadTask('strict')
    const { unmount } = renderHook(() => useUploadTask(task), {
      wrapper: StrictMode,
    })

    expect(task.listenerCount).toBe(1)
    expect(task.subscribeCalls).toBe(2)
    expect(task.start).not.toHaveBeenCalled()

    unmount()
    expect(task.listenerCount).toBe(0)
    expect(task.unsubscribeCalls).toBe(2)
  })

  it('provides the current task snapshot during server rendering', () => {
    const task = new FakeUploadTask('server')

    function Probe(): React.ReactNode {
      const state = useUploadTask(task)
      return <span>{`${state?.id}:${state?.status}`}</span>
    }

    expect(renderToString(<Probe />)).toContain('server:paused')
    expect(task.subscribeCalls).toBe(0)
  })

  it('provides an empty server snapshot without a task', () => {
    function Probe(): React.ReactNode {
      return <span>{useUploadTask(null)?.status ?? 'empty'}</span>
    }

    expect(renderToString(<Probe />)).toContain('empty')
  })
})

describe('useResumableUpload', () => {
  it('creates a task, exposes live state, and delegates explicit actions', async () => {
    const task = new FakeUploadTask('created')
    const create = vi.fn(async () => task)
    const client = createClient({ create })
    const { result } = renderHook(() => useResumableUpload(client))
    const initialActions = actionReferences(result.current)

    await act(async () => {
      await result.current.create({ source })
    })

    expect(create).toHaveBeenCalledWith({ source })
    expect(result.current.task).toBe(task)
    expect(result.current.state).toMatchObject({ id: 'created', status: 'paused' })
    expect(result.current.operationStatus).toBe('idle')
    expect(actionReferences(result.current)).toEqual(initialActions)

    act(() => task.emit({ confirmedOffset: 1, status: 'uploading' }))
    expect(result.current.state).toMatchObject({ confirmedOffset: 1, status: 'uploading' })

    await act(async () => {
      await result.current.start()
      result.current.pause()
      await result.current.cancel()
    })
    expect(task.start).toHaveBeenCalledOnce()
    expect(task.pause).toHaveBeenCalledOnce()
    expect(task.cancel).toHaveBeenCalledOnce()
  })

  it('keeps the newest async selection when an older operation resolves last', async () => {
    const older = new FakeUploadTask('older')
    const newer = new FakeUploadTask('newer')
    const pendingCreate = deferred<UploadTask>()
    const client = createClient({
      create: vi.fn(() => pendingCreate.promise),
      resume: vi.fn(async () => newer),
    })
    const { result } = renderHook(() => useResumableUpload(client))
    let olderOperation: Promise<UploadTask> | undefined

    act(() => {
      olderOperation = result.current.create({ source })
    })
    expect(result.current.operationStatus).toBe('creating')

    await act(async () => {
      await result.current.resume('saved', source)
    })
    expect(result.current.task).toBe(newer)

    await act(async () => {
      pendingCreate.resolve(older)
      await olderOperation
    })
    expect(result.current.task).toBe(newer)
    expect(older.listenerCount).toBe(0)
  })

  it('reports operation failures without replacing the selected task', async () => {
    const selected = new FakeUploadTask('selected')
    const resume = vi.fn<ResumableUploadClient['resume']>()
    resume.mockRejectedValue('checkpoint unavailable')
    const client = createClient({
      create: vi.fn(async () => selected),
      resume,
    })
    const { result } = renderHook(() => useResumableUpload(client))

    await act(async () => {
      await result.current.create({ source })
    })
    let rejection: unknown
    await act(async () => {
      try {
        await result.current.resume('missing', source)
      } catch (error) {
        rejection = error
      }
    })

    expect(rejection).toMatchObject({ message: 'The upload operation failed' })
    expect(result.current.task).toBe(selected)
    expect(result.current.operationError).toMatchObject({
      cause: 'checkpoint unavailable',
      message: 'The upload operation failed',
    })
    expect(result.current.operationStatus).toBe('idle')
  })

  it('clears selection without canceling and rejects actions without a task', async () => {
    const task = new FakeUploadTask('clearable')
    const client = createClient({ create: vi.fn(async () => task) })
    const { result, unmount } = renderHook(() => useResumableUpload(client))

    await expect(result.current.start()).rejects.toThrow('No upload task')
    expect(() => result.current.pause()).toThrow('No upload task')
    await expect(result.current.cancel()).rejects.toThrow('No upload task')

    await act(async () => {
      await result.current.create({ source })
    })
    act(() => result.current.clearTask())
    expect(result.current.task).toBeNull()
    expect(task.cancel).not.toHaveBeenCalled()
    expect(task.listenerCount).toBe(0)

    unmount()
    expect(task.cancel).not.toHaveBeenCalled()
  })

  it('drops the selected task when the client identity changes', async () => {
    const task = new FakeUploadTask('first-client')
    const firstClient = createClient({ create: vi.fn(async () => task) })
    const secondClient = createClient()
    const { result, rerender } = renderHook(
      ({ client }: { client: ResumableUploadClient }) => useResumableUpload(client),
      { initialProps: { client: firstClient } },
    )

    await act(async () => {
      await result.current.create({ source })
    })
    rerender({ client: secondClient })

    expect(result.current.task).toBeNull()
    expect(task.listenerCount).toBe(0)
    expect(task.cancel).not.toHaveBeenCalled()
  })

  it('does not adopt a task that resolves after unmount', async () => {
    const task = new FakeUploadTask('late')
    const pendingCreate = deferred<UploadTask>()
    const client = createClient({ create: vi.fn(() => pendingCreate.promise) })
    const { result, unmount } = renderHook(() => useResumableUpload(client))

    let operation: Promise<UploadTask> | undefined
    act(() => {
      operation = result.current.create({ source })
    })
    unmount()
    pendingCreate.resolve(task)
    await operation

    expect(task.listenerCount).toBe(0)
    expect(task.cancel).not.toHaveBeenCalled()
  })

  it('keeps a newer operation state when an obsolete request fails', async () => {
    const olderRequest = deferred<UploadTask>()
    const selected = new FakeUploadTask('selected')
    const client = createClient({
      create: vi.fn(() => olderRequest.promise),
      resume: vi.fn(async () => selected),
    })
    const { result } = renderHook(() => useResumableUpload(client))
    let obsolete: Promise<UploadTask> | undefined

    act(() => {
      obsolete = result.current.create({ source })
    })
    await act(async () => {
      await result.current.resume('selected', source)
    })
    olderRequest.reject(new Error('obsolete failure'))
    await expect(obsolete).rejects.toThrow('obsolete failure')

    expect(result.current.task).toBe(selected)
    expect(result.current.operationError).toBeNull()
    expect(result.current.operationStatus).toBe('idle')
  })
})

describe('usePendingUploads', () => {
  it('loads checkpoints once in StrictMode and supports an explicit refresh', async () => {
    const initial = checkpoint('initial')
    const refreshed = checkpoint('refreshed')
    const list = vi.fn<ResumableUploadClient['list']>()
    list.mockResolvedValueOnce([initial]).mockResolvedValueOnce([refreshed])
    const client = createClient({ list })
    const { result } = renderHook(() => usePendingUploads(client), { wrapper: StrictMode })

    expect(result.current.isLoading).toBe(true)
    await waitFor(() => expect(result.current.checkpoints).toEqual([initial]))
    expect(list).toHaveBeenCalledOnce()

    await act(async () => {
      await result.current.refresh()
    })
    expect(result.current.checkpoints).toEqual([refreshed])
    expect(result.current.isLoading).toBe(false)
  })

  it('exposes normalized loading failures and can recover', async () => {
    const recovered = checkpoint('recovered')
    const list = vi.fn<ResumableUploadClient['list']>()
    list.mockRejectedValueOnce('storage blocked').mockResolvedValueOnce([recovered])
    const client = createClient({ list })
    const { result } = renderHook(() => usePendingUploads(client))

    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(result.current.error).toMatchObject({
      cause: 'storage blocked',
      message: 'Could not load pending uploads',
    })
    expect(result.current.isLoading).toBe(false)

    await act(async () => {
      await result.current.refresh()
    })
    expect(result.current.checkpoints).toEqual([recovered])
    expect(result.current.error).toBeNull()
  })

  it('ignores an old client response after the client changes', async () => {
    const oldRequest = deferred<readonly UploadCheckpoint[]>()
    const oldClient = createClient({ list: vi.fn(() => oldRequest.promise) })
    const current = checkpoint('current')
    const newClient = createClient({ list: vi.fn(async () => [current]) })
    const { result, rerender } = renderHook(
      ({ client }: { client: ResumableUploadClient }) => usePendingUploads(client),
      { initialProps: { client: oldClient } },
    )

    rerender({ client: newClient })
    await waitFor(() => expect(result.current.checkpoints).toEqual([current]))
    oldRequest.resolve([checkpoint('obsolete')])
    await oldRequest.promise

    expect(result.current.checkpoints).toEqual([current])
  })

  it('settles an in-flight request safely after unmount', async () => {
    const request = deferred<readonly UploadCheckpoint[]>()
    const client = createClient({ list: vi.fn(() => request.promise) })
    const { unmount } = renderHook(() => usePendingUploads(client))

    unmount()
    request.resolve([checkpoint('late')])
    await request.promise
  })

  it('ignores an in-flight failure after unmount', async () => {
    const request = deferred<readonly UploadCheckpoint[]>()
    const client = createClient({ list: vi.fn(() => request.promise) })
    const { unmount } = renderHook(() => usePendingUploads(client))

    unmount()
    request.reject(new Error('late failure'))
    await expect(request.promise).rejects.toThrow('late failure')
  })
})

class FakeUploadTask implements UploadTask {
  readonly cancel = vi.fn(async (): Promise<void> => undefined)
  readonly pause = vi.fn((): void => undefined)
  readonly start = vi.fn(async (): Promise<UploadTaskState> => this.state)
  readonly #listeners = new Set<UploadTaskListener>()
  #state: UploadTaskState
  subscribeCalls = 0
  unsubscribeCalls = 0

  constructor(readonly id: string) {
    this.#state = Object.freeze({
      attempt: 0,
      confirmedOffset: 0,
      error: null,
      id,
      status: 'paused',
      totalBytes: 3,
      uploadUrl: null,
    })
  }

  get listenerCount(): number {
    return this.#listeners.size
  }

  get state(): UploadTaskState {
    return this.#state
  }

  emit(update: Partial<UploadTaskState>): void {
    this.#state = Object.freeze({ ...this.#state, ...update })
    this.#listeners.forEach((listener) => listener(this.#state))
  }

  subscribe(listener: UploadTaskListener): () => void {
    this.subscribeCalls += 1
    this.#listeners.add(listener)
    listener(this.#state)
    return () => {
      this.unsubscribeCalls += 1
      this.#listeners.delete(listener)
    }
  }
}

function createClient(overrides: Partial<ResumableUploadClient> = {}): ResumableUploadClient {
  return {
    create: vi.fn(async (_input: CreateUploadTaskInput) => new FakeUploadTask('created')),
    list: vi.fn(async () => []),
    resume: vi.fn(async (id: string, _source: UploadSource) => new FakeUploadTask(id)),
    terminate: vi.fn(async () => undefined),
    ...overrides,
  }
}

function checkpoint(id: string): UploadCheckpoint {
  return Object.freeze({
    confirmedOffset: 1,
    createdAt: '2026-08-19T12:00:00.000Z',
    expiresAt: null,
    id,
    lastErrorCode: null,
    metadata: [],
    phase: 'paused',
    size: 3,
    sourceFingerprint: source.fingerprint,
    updatedAt: '2026-08-19T12:00:01.000Z',
    uploadUrl: `https://uploads.example.test/${id}`,
  })
}

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly reject: (reason?: unknown) => void
  readonly resolve: (value: T) => void
} {
  let rejectPromise: (reason?: unknown) => void = () => undefined
  let resolvePromise: (value: T) => void = () => undefined
  const promise = new Promise<T>((resolve, reject) => {
    rejectPromise = reject
    resolvePromise = resolve
  })
  return { promise, reject: rejectPromise, resolve: resolvePromise }
}

function actionReferences(result: ReturnType<typeof useResumableUpload>): readonly unknown[] {
  return [result.cancel, result.clearTask, result.create, result.pause, result.resume, result.start]
}
