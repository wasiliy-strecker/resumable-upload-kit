import { performance } from 'node:perf_hooks'

import { TusProtocolError } from '@resumable-upload-kit/protocol'

import type {
  InstrumentUploadServiceOptions,
  UploadOperation,
  UploadRecord,
  UploadService,
  UploadTelemetryEvent,
} from './types.js'

export function instrumentUploadService(
  service: UploadService,
  options: InstrumentUploadServiceOptions,
): UploadService {
  const clock = options.monotonicClock ?? (() => performance.now())

  return {
    limits: service.limits,

    append: async (input) =>
      measure(
        'append',
        () => service.append(input),
        (upload) => {
          record(options, { bytes: input.contentLength, kind: 'bytes_confirmed' })
          recordCompletion(options, upload)
        },
        clock,
        options,
      ),

    create: async (input) =>
      measure(
        'create',
        () => service.create(input),
        (upload) => {
          record(options, { kind: 'upload_created' })
          recordCompletion(options, upload)
        },
        clock,
        options,
      ),

    head: async (uploadId, ownerId) =>
      measure('head', () => service.head(uploadId, ownerId), undefined, clock, options),

    terminate: async (uploadId, ownerId) =>
      measure(
        'terminate',
        () => service.terminate(uploadId, ownerId),
        () => record(options, { kind: 'upload_terminated' }),
        clock,
        options,
      ),
  }
}

async function measure<T>(
  operation: UploadOperation,
  execute: () => Promise<T>,
  onSuccess: ((result: T) => void) | undefined,
  clock: () => number,
  options: InstrumentUploadServiceOptions,
): Promise<T> {
  const startedAt = safeClock(clock)

  try {
    const result = await execute()
    onSuccess?.(result)
    record(options, {
      durationMs: elapsed(startedAt, clock),
      kind: 'operation',
      operation,
      outcome: 'success',
    })
    return result
  } catch (error) {
    record(options, {
      durationMs: elapsed(startedAt, clock),
      errorCode: error instanceof TusProtocolError ? error.code : 'internal',
      kind: 'operation',
      operation,
      outcome: 'error',
    })
    throw error
  }
}

function recordCompletion(options: InstrumentUploadServiceOptions, upload: UploadRecord): void {
  if (upload.status === 'completed') record(options, { kind: 'upload_completed' })
}

export function recordUploadTelemetry(
  telemetry: InstrumentUploadServiceOptions['telemetry'] | undefined,
  event: UploadTelemetryEvent,
): void {
  if (!telemetry) return

  try {
    telemetry.record(Object.freeze(event))
  } catch {
    // Observability must never change upload correctness or availability.
  }
}

function record(options: InstrumentUploadServiceOptions, event: UploadTelemetryEvent): void {
  recordUploadTelemetry(options.telemetry, event)
}

export function measureTelemetryDuration(
  startedAt: number,
  clock: (() => number) | undefined,
): number {
  return elapsed(startedAt, clock ?? (() => performance.now()))
}

export function readTelemetryClock(clock: (() => number) | undefined): number {
  return safeClock(clock ?? (() => performance.now()))
}

function elapsed(startedAt: number, clock: () => number): number {
  return Math.max(0, safeClock(clock) - startedAt)
}

function safeClock(clock: () => number): number {
  const value = clock()
  return Number.isFinite(value) ? value : 0
}
