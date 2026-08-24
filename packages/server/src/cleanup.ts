import { randomUUID } from 'node:crypto'

import type {
  CreateUploadCleanupWorkerOptions,
  UploadCleanupClaim,
  UploadCleanupRunResult,
  UploadCleanupScheduler,
  UploadCleanupSchedulerOptions,
  UploadCleanupWorker,
} from './types.js'

const defaultBatchSize = 50
const defaultClaimDurationMs = 5 * 60 * 1_000
const defaultConcurrency = 4
const maximumBatchSize = 1_000
const maximumConcurrency = 32
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

export function createUploadCleanupWorker(
  options: CreateUploadCleanupWorkerOptions,
): UploadCleanupWorker {
  const batchSize = boundedInteger(
    options.batchSize ?? defaultBatchSize,
    'batchSize',
    maximumBatchSize,
  )
  const claimDurationMs = positiveInteger(
    options.claimDurationMs ?? defaultClaimDurationMs,
    'claimDurationMs',
  )
  const concurrency = boundedInteger(
    options.concurrency ?? defaultConcurrency,
    'concurrency',
    maximumConcurrency,
  )
  const clock = options.clock ?? (() => new Date())
  const createClaimId = options.createClaimId ?? randomUUID

  return {
    async runOnce(): Promise<UploadCleanupRunResult> {
      const now = validDate(clock(), 'clock')
      const claimId = createClaimId()

      if (!uuidPattern.test(claimId)) {
        throw new Error('Cleanup claim identifiers must be lowercase RFC 9562 UUIDs')
      }

      const claims = await options.repository.claimExpired({
        batchSize,
        claimExpiresAt: new Date(now.getTime() + claimDurationMs),
        claimId,
        now,
      })
      let cleaned = 0
      let failed = 0

      await runBounded(claims, concurrency, async (claim) => {
        const didClean = await cleanClaim(options, clock, claim)

        if (didClean) {
          cleaned += 1
        } else {
          failed += 1
        }
      })

      return Object.freeze({ claimed: claims.length, cleaned, failed })
    },
  }
}

export function startUploadCleanupScheduler(
  worker: UploadCleanupWorker,
  options: UploadCleanupSchedulerOptions,
): UploadCleanupScheduler {
  positiveInteger(options.intervalMs, 'intervalMs')
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let running: Promise<void> | undefined

  const schedule = (): void => {
    if (stopped) return

    timer = setTimeout(() => {
      running = execute().finally(() => {
        running = undefined
        schedule()
      })
    }, options.intervalMs)
    timer.unref?.()
  }

  const execute = async (): Promise<void> => {
    try {
      const result = await worker.runOnce()
      options.onResult?.(result)
    } catch (error) {
      try {
        options.onError?.(error)
      } catch {
        // Observer failures must not create an unhandled scheduler rejection.
      }
    }
  }

  running = execute().finally(() => {
    running = undefined
    schedule()
  })

  return {
    async stop(): Promise<void> {
      stopped = true
      if (timer) clearTimeout(timer)
      await running
    },
  }
}

async function cleanClaim(
  options: CreateUploadCleanupWorkerOptions,
  clock: () => Date,
  claim: UploadCleanupClaim,
): Promise<boolean> {
  const completedAt = validDate(clock(), 'clock')

  try {
    await options.blobStore.delete(claim.uploadId)
    return await options.repository.completeCleanup({
      claimId: claim.claimId,
      now: completedAt,
      uploadId: claim.uploadId,
    })
  } catch {
    await options.repository
      .releaseCleanup({
        claimId: claim.claimId,
        now: completedAt,
        uploadId: claim.uploadId,
      })
      .catch(() => undefined)
    return false
  }
}

async function runBounded<T>(
  values: readonly T[],
  concurrency: number,
  execute: (value: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0
  const runners = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const value = values[nextIndex]
      nextIndex += 1
      if (value !== undefined) await execute(value)
    }
  })

  await Promise.all(runners)
}

function boundedInteger(value: number, name: string, maximum: number): number {
  positiveInteger(value, name)

  if (value > maximum) {
    throw new Error(`${name} must not exceed ${maximum}`)
  }

  return value
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`)
  }

  return value
}

function validDate(value: Date, name: string): Date {
  if (!Number.isFinite(value.getTime())) {
    throw new Error(`${name} must return a valid Date`)
  }

  return value
}
