import { describe, expect, it } from 'vitest'

import { TusProtocolError } from '@resumable-upload-kit/protocol'

import { instrumentUploadService } from '../src/telemetry.js'
import type {
  AppendUploadInput,
  CreateUploadInput,
  UploadRecord,
  UploadService,
  UploadTelemetryEvent,
} from '../src/types.js'

const uploadId = '018f1111-1111-7111-8111-111111111111'

describe('upload telemetry', () => {
  it('records bounded lifecycle, byte, outcome, and duration events', async () => {
    const events: UploadTelemetryEvent[] = []
    const times = [10, 15, 20, 28, 30, 32, 40, 41]
    const service = instrumentUploadService(new StubService(), {
      monotonicClock: () => times.shift() ?? 41,
      telemetry: { record: (event) => events.push(event) },
    })

    await service.create({ length: 5, metadata: [], ownerId: 'sensitive-owner' })
    await service.append({
      contentLength: 5,
      offset: 0,
      ownerId: 'sensitive-owner',
      source: chunks(new Uint8Array([1, 2, 3, 4, 5])),
      uploadId,
    })
    await service.head(uploadId, 'sensitive-owner')
    await service.terminate(uploadId, 'sensitive-owner')

    expect(events).toEqual([
      { kind: 'upload_created' },
      { durationMs: 5, kind: 'operation', operation: 'create', outcome: 'success' },
      { bytes: 5, kind: 'bytes_confirmed' },
      { kind: 'upload_completed' },
      { durationMs: 8, kind: 'operation', operation: 'append', outcome: 'success' },
      { durationMs: 2, kind: 'operation', operation: 'head', outcome: 'success' },
      { kind: 'upload_terminated' },
      { durationMs: 1, kind: 'operation', operation: 'terminate', outcome: 'success' },
    ])
    expect(JSON.stringify(events)).not.toContain('sensitive-owner')
    expect(JSON.stringify(events)).not.toContain(uploadId)
    expect(events.every(Object.isFrozen)).toBe(true)
  })

  it('classifies protocol and internal failures without changing thrown errors', async () => {
    const events: UploadTelemetryEvent[] = []
    const service = instrumentUploadService(new StubService({ fail: true }), {
      monotonicClock: () => 10,
      telemetry: { record: (event) => events.push(event) },
    })

    await expect(service.head(uploadId, 'owner')).rejects.toMatchObject({
      code: 'upload_not_found',
    })
    await expect(
      service.append({
        contentLength: 1,
        offset: 0,
        ownerId: 'owner',
        source: chunks(new Uint8Array([1])),
        uploadId,
      }),
    ).rejects.toThrow('storage offline')

    expect(events).toEqual([
      {
        durationMs: 0,
        errorCode: 'upload_not_found',
        kind: 'operation',
        operation: 'head',
        outcome: 'error',
      },
      {
        durationMs: 0,
        errorCode: 'internal',
        kind: 'operation',
        operation: 'append',
        outcome: 'error',
      },
    ])
  })

  it('isolates observer failures and clamps invalid or decreasing clocks', async () => {
    const values = [Number.NaN, -5]
    const service = instrumentUploadService(new StubService(), {
      monotonicClock: () => values.shift() ?? -5,
      telemetry: {
        record(): void {
          throw new Error('metrics backend failed')
        },
      },
    })

    await expect(service.head(uploadId, 'owner')).resolves.toMatchObject({ id: uploadId })
  })

  it('records zero-length uploads as created and completed', async () => {
    const events: UploadTelemetryEvent[] = []
    const service = instrumentUploadService(new StubService(), {
      telemetry: { record: (event) => events.push(event) },
    })

    await service.create({ length: 0, metadata: [], ownerId: 'owner' })

    expect(events.map((event) => event.kind)).toEqual([
      'upload_created',
      'upload_completed',
      'operation',
    ])
  })
})

class StubService implements UploadService {
  public readonly limits = {
    expirationMs: 86_400_000,
    leaseDurationMs: 30_000,
    maximumChunkBytes: 5_242_880,
    maximumUploadBytes: 262_144_000,
  }

  public constructor(private readonly options: { readonly fail?: boolean } = {}) {}

  public async append(input: AppendUploadInput): Promise<UploadRecord> {
    if (this.options.fail) throw new Error('storage offline')
    return record({ length: input.contentLength, offset: input.contentLength, status: 'completed' })
  }

  public async create(input: CreateUploadInput): Promise<UploadRecord> {
    return record({
      expiresAt: input.length === 0 ? null : new Date('2026-08-26T10:00:00.000Z'),
      length: input.length,
      offset: 0,
      status: input.length === 0 ? 'completed' : 'active',
    })
  }

  public async head(_uploadId: string, _ownerId: string): Promise<UploadRecord> {
    if (this.options.fail) {
      throw new TusProtocolError({
        code: 'upload_not_found',
        message: 'Upload does not exist',
        status: 404,
      })
    }
    return record()
  }

  public async terminate(_uploadId: string, _ownerId: string): Promise<void> {}
}

function record(overrides: Partial<UploadRecord> = {}): UploadRecord {
  return {
    createdAt: new Date('2026-08-25T10:00:00.000Z'),
    expiresAt: new Date('2026-08-26T10:00:00.000Z'),
    id: uploadId,
    leaseExpiresAt: null,
    leaseId: null,
    length: 5,
    metadata: [],
    offset: 0,
    ownerId: 'sensitive-owner',
    status: 'active',
    updatedAt: new Date('2026-08-25T10:00:00.000Z'),
    ...overrides,
  }
}

async function* chunks(...values: Uint8Array[]): AsyncIterable<Uint8Array> {
  yield* values
}
