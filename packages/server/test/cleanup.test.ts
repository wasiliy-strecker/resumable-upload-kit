import { afterEach, describe, expect, it, vi } from 'vitest'

import { createUploadCleanupWorker, startUploadCleanupScheduler } from '../src/cleanup.js'
import type {
  ClaimExpiredUploadsInput,
  CompleteUploadCleanupInput,
  ReleaseUploadCleanupInput,
  UploadCleanupRepository,
  UploadCleanupRunResult,
  UploadCleanupWorker,
  UploadTelemetry,
  UploadTelemetryEvent,
} from '../src/types.js'

const now = new Date('2026-08-23T10:00:00.000Z')
const claimId = '018f1111-1111-7111-8111-111111111111'
const uploadIds = [
  '018f2222-2222-7222-8222-222222222222',
  '018f3333-3333-7333-8333-333333333333',
  '018f4444-4444-7444-8444-444444444444',
]

afterEach(() => {
  vi.useRealTimers()
})

describe('upload cleanup worker', () => {
  it('claims a bounded batch and marks successfully deleted blobs as cleaned', async () => {
    const harness = createHarness()

    await expect(harness.worker.runOnce()).resolves.toEqual({ claimed: 3, cleaned: 3, failed: 0 })
    expect(harness.repository.claimInputs).toEqual([
      {
        batchSize: 50,
        claimExpiresAt: new Date('2026-08-23T10:05:00.000Z'),
        claimId,
        now,
      },
    ])
    expect(harness.blobStore.deleted).toEqual(expect.arrayContaining(uploadIds))
    expect(harness.repository.completeInputs).toHaveLength(3)
    expect(harness.repository.releaseInputs).toHaveLength(0)
  })

  it('bounds deletion concurrency and supports explicit worker limits', async () => {
    let active = 0
    let maximumActive = 0
    const harness = createHarness({ batchSize: 3, claimDurationMs: 1_000, concurrency: 2 })
    harness.blobStore.onDelete = async () => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await Promise.resolve()
      active -= 1
    }

    await harness.worker.runOnce()

    expect(maximumActive).toBe(2)
    expect(harness.repository.claimInputs[0]).toMatchObject({
      batchSize: 3,
      claimExpiresAt: new Date('2026-08-23T10:00:01.000Z'),
    })
  })

  it('releases failed deletes and leaves lost claims retryable without masking failures', async () => {
    const harness = createHarness()
    harness.blobStore.failures.add(uploadIds[0] ?? '')
    harness.repository.lostClaims.add(uploadIds[1] ?? '')
    harness.repository.rejectRelease = true

    await expect(harness.worker.runOnce()).resolves.toEqual({ claimed: 3, cleaned: 1, failed: 2 })
    expect(harness.repository.releaseInputs).toEqual([{ claimId, now, uploadId: uploadIds[0] }])
  })

  it('makes an already deleted blob retryable when completion persistence fails', async () => {
    const harness = createHarness()
    harness.repository.rejectComplete = true

    await expect(harness.worker.runOnce()).resolves.toEqual({ claimed: 3, cleaned: 0, failed: 3 })
    expect(harness.repository.releaseInputs).toHaveLength(3)
  })

  it('returns an empty immutable report when no uploads are eligible', async () => {
    const harness = createHarness()
    harness.repository.uploadIds = []

    const result = await harness.worker.runOnce()

    expect(result).toEqual({ claimed: 0, cleaned: 0, failed: 0 })
    expect(Object.isFrozen(result)).toBe(true)
  })

  it('rejects invalid configuration, clocks, identifiers, and claim failures', async () => {
    for (const options of [
      { batchSize: 0 },
      { batchSize: 1_001 },
      { claimDurationMs: 0 },
      { concurrency: 0 },
      { concurrency: 33 },
    ]) {
      expect(() => createHarness(options)).toThrow()
    }

    await expect(
      createHarness({ clock: () => new Date(Number.NaN) }).worker.runOnce(),
    ).rejects.toThrow('clock')
    await expect(
      createHarness({ createClaimId: () => 'invalid' }).worker.runOnce(),
    ).rejects.toThrow('RFC 9562')

    const harness = createHarness()
    harness.repository.rejectClaim = true
    await expect(harness.worker.runOnce()).rejects.toThrow('database unavailable')
  })

  it('rejects an invalid completion clock as an operational configuration failure', async () => {
    const values = [now, new Date(Number.NaN)]
    const harness = createHarness({ clock: () => values.shift() ?? now })

    await expect(harness.worker.runOnce()).rejects.toThrow('clock')
  })

  it('records successful, partial, and failed cleanup runs without resource identifiers', async () => {
    const events: UploadTelemetryEvent[] = []
    const successful = createHarness({
      monotonicClock: sequence(10, 25),
      telemetry: { record: (event) => events.push(event) },
    })
    successful.blobStore.failures.add(uploadIds[0] ?? '')

    await successful.worker.runOnce()
    expect(events).toEqual([
      {
        claimed: 3,
        cleaned: 2,
        durationMs: 15,
        failed: 1,
        kind: 'cleanup',
        outcome: 'partial',
      },
    ])

    const failed = createHarness({
      monotonicClock: sequence(30, 35),
      telemetry: { record: (event) => events.push(event) },
    })
    failed.repository.rejectClaim = true
    await expect(failed.worker.runOnce()).rejects.toThrow('database unavailable')
    expect(events.at(-1)).toEqual({
      durationMs: 5,
      kind: 'cleanup',
      outcome: 'error',
    })
    expect(JSON.stringify(events)).not.toContain(uploadIds[0])
  })

  it('does not let cleanup telemetry failures affect cleanup', async () => {
    const harness = createHarness({
      telemetry: {
        record(): void {
          throw new Error('metrics unavailable')
        },
      },
    })

    await expect(harness.worker.runOnce()).resolves.toEqual({ claimed: 3, cleaned: 3, failed: 0 })
  })
})

describe('upload cleanup scheduler', () => {
  it('runs immediately, schedules without overlap, reports results, and stops cleanly', async () => {
    vi.useFakeTimers()
    let resolveRun: ((result: UploadCleanupRunResult) => void) | undefined
    const runOnce = vi.fn(
      () =>
        new Promise<UploadCleanupRunResult>((resolve) => {
          resolveRun = resolve
        }),
    )
    const worker: UploadCleanupWorker = {
      runOnce,
    }
    const onResult = vi.fn()
    const scheduler = startUploadCleanupScheduler(worker, { intervalMs: 100, onResult })

    await vi.advanceTimersByTimeAsync(1_000)
    expect(runOnce).toHaveBeenCalledOnce()

    resolveRun?.({ claimed: 1, cleaned: 1, failed: 0 })
    await vi.advanceTimersByTimeAsync(100)
    expect(onResult).toHaveBeenCalledWith({ claimed: 1, cleaned: 1, failed: 0 })
    expect(runOnce).toHaveBeenCalledTimes(2)

    const stopping = scheduler.stop()
    resolveRun?.({ claimed: 0, cleaned: 0, failed: 0 })
    await stopping
    await vi.advanceTimersByTimeAsync(1_000)
    expect(runOnce).toHaveBeenCalledTimes(2)
  })

  it('reports worker and observer failures and validates its interval', async () => {
    vi.useFakeTimers()
    const worker: UploadCleanupWorker = {
      runOnce: vi.fn(async () => ({ claimed: 1, cleaned: 1, failed: 0 })),
    }
    const observerFailure = new Error('observer failed')
    const onError = vi.fn()
    const scheduler = startUploadCleanupScheduler(worker, {
      intervalMs: 100,
      onError,
      onResult: () => {
        throw observerFailure
      },
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(onError).toHaveBeenCalledWith(observerFailure)
    await scheduler.stop()

    const workerFailure = new Error('claim failed')
    const failingWorker: UploadCleanupWorker = {
      runOnce: vi.fn(async () => Promise.reject(workerFailure)),
    }
    const failureScheduler = startUploadCleanupScheduler(failingWorker, {
      intervalMs: 100,
      onError,
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(onError).toHaveBeenCalledWith(workerFailure)
    await failureScheduler.stop()

    const rejectingObserverScheduler = startUploadCleanupScheduler(failingWorker, {
      intervalMs: 100,
      onError: () => {
        throw new Error('logger failed')
      },
    })
    await vi.advanceTimersByTimeAsync(0)
    await expect(rejectingObserverScheduler.stop()).resolves.toBeUndefined()

    expect(() => startUploadCleanupScheduler(worker, { intervalMs: 0 })).toThrow('intervalMs')
  })
})

interface HarnessOptions {
  readonly batchSize?: number
  readonly claimDurationMs?: number
  readonly clock?: () => Date
  readonly concurrency?: number
  readonly createClaimId?: () => string
  readonly monotonicClock?: () => number
  readonly telemetry?: UploadTelemetry
}

function createHarness(options: HarnessOptions = {}) {
  const repository = new MemoryCleanupRepository()
  const blobStore = new MemoryDeleteStore()
  const worker = createUploadCleanupWorker({
    blobStore,
    clock: options.clock ?? (() => now),
    createClaimId: options.createClaimId ?? (() => claimId),
    ...(options.monotonicClock ? { monotonicClock: options.monotonicClock } : {}),
    repository,
    ...(options.telemetry ? { telemetry: options.telemetry } : {}),
    ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
    ...(options.claimDurationMs === undefined ? {} : { claimDurationMs: options.claimDurationMs }),
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
  })
  return { blobStore, repository, worker }
}

function sequence(...values: number[]): () => number {
  return () => values.shift() ?? 0
}

class MemoryCleanupRepository implements UploadCleanupRepository {
  public claimInputs: ClaimExpiredUploadsInput[] = []
  public completeInputs: CompleteUploadCleanupInput[] = []
  public lostClaims = new Set<string>()
  public rejectClaim = false
  public rejectComplete = false
  public rejectRelease = false
  public releaseInputs: ReleaseUploadCleanupInput[] = []
  public uploadIds = [...uploadIds]

  public async claimExpired(
    input: ClaimExpiredUploadsInput,
  ): Promise<readonly { claimId: string; uploadId: string }[]> {
    this.claimInputs.push(input)
    if (this.rejectClaim) throw new Error('database unavailable')
    return this.uploadIds.map((uploadId) => ({ claimId: input.claimId, uploadId }))
  }

  public async completeCleanup(input: CompleteUploadCleanupInput): Promise<boolean> {
    this.completeInputs.push(input)
    if (this.rejectComplete) throw new Error('database unavailable')
    return !this.lostClaims.has(input.uploadId)
  }

  public async releaseCleanup(input: ReleaseUploadCleanupInput): Promise<void> {
    this.releaseInputs.push(input)
    if (this.rejectRelease) throw new Error('database unavailable')
  }
}

class MemoryDeleteStore {
  public deleted: string[] = []
  public failures = new Set<string>()
  public onDelete: (() => Promise<void>) | undefined

  public async delete(uploadId: string): Promise<void> {
    this.deleted.push(uploadId)
    await this.onDelete?.()
    if (this.failures.has(uploadId)) throw new Error('filesystem unavailable')
  }
}
