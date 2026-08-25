import { createHash } from 'node:crypto'

import type { TusErrorCode, TusProtocolError } from '@resumable-upload-kit/protocol'
import { describe, expect, it } from 'vitest'

import { createUploadService } from '../src/service.js'
import {
  UploadBlobError,
  type AcquireUploadLeaseInput,
  type AcquireUploadLeaseResult,
  type CommitUploadLeaseInput,
  type CommitUploadLeaseResult,
  type CreateUploadRecordInput,
  type ReleaseUploadLeaseInput,
  type StageUploadChunkInput,
  type StagedUploadChunk,
  type TerminateUploadInput,
  type TerminateUploadResult,
  type UploadBlobStore,
  type UploadLookupResult,
  type UploadRecord,
  type UploadRepository,
  type UploadTelemetry,
  type UploadTelemetryEvent,
} from '../src/types.js'

const uploadId = '018f1111-1111-7111-8111-111111111111'
const leaseId = '018f2222-2222-7222-8222-222222222222'
const now = new Date('2026-08-16T10:00:00.000Z')

describe('createUploadService', () => {
  it('creates active and already-complete resources with bounded expiration', async () => {
    const harness = createHarness()
    const active = await harness.service.create({
      length: 5,
      metadata: [{ key: 'filename', value: new TextEncoder().encode('demo.txt') }],
      ownerId: 'owner-1',
    })

    expect(active).toMatchObject({
      expiresAt: new Date('2026-08-17T10:00:00.000Z'),
      id: uploadId,
      length: 5,
      offset: 0,
      status: 'active',
    })
    expect(harness.blobs.created).toEqual([uploadId])

    const emptyHarness = createHarness()
    const complete = await emptyHarness.service.create({
      length: 0,
      metadata: [],
      ownerId: 'owner-1',
    })
    expect(complete).toMatchObject({ expiresAt: null, status: 'completed' })
  })

  it('rejects invalid limits, ownership, lengths, and generated identifiers', async () => {
    expect(() =>
      createHarness({ limits: { maximumChunkBytes: 11, maximumUploadBytes: 10 } }),
    ).toThrow('must not exceed')
    expect(() => createHarness({ limits: { expirationMs: 0 } })).toThrow('positive safe integer')

    for (const length of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(
        createHarness().service.create({ length, metadata: [], ownerId: 'owner' }),
      ).rejects.toMatchObject({
        code: 'invalid_header',
        status: 400,
      })
    }

    await expect(
      createHarness({ limits: { maximumChunkBytes: 4, maximumUploadBytes: 4 } }).service.create({
        length: 5,
        metadata: [],
        ownerId: 'owner',
      }),
    ).rejects.toMatchObject({ code: 'upload_too_large', status: 413 })
    await expect(
      createHarness().service.create({ length: 1, metadata: [], ownerId: ' owner' }),
    ).rejects.toMatchObject({
      code: 'unauthorized',
      status: 401,
    })
    await expect(
      createHarness({ ids: ['not-a-uuid'] }).service.create({
        length: 1,
        metadata: [],
        ownerId: 'owner',
      }),
    ).rejects.toThrow('RFC 9562')
  })

  it('removes the new blob when metadata persistence fails', async () => {
    const harness = createHarness()
    harness.repository.createError = new Error('database offline')
    harness.blobs.rejectDelete = true

    await expect(
      harness.service.create({ length: 1, metadata: [], ownerId: 'owner' }),
    ).rejects.toThrow('database offline')
    expect(harness.blobs.deleted).toEqual([uploadId])
  })

  it('isolates owners and reports expired and malformed resources without leaking them', async () => {
    const harness = createHarness()
    await harness.service.create({ length: 2, metadata: [], ownerId: 'owner' })

    await expect(harness.service.head(uploadId, 'other-owner')).rejects.toMatchObject({
      status: 404,
    })
    await expect(harness.service.head('not-a-uuid', 'owner')).rejects.toMatchObject({ status: 404 })
    harness.repository.record = { ...requireRecord(harness.repository.record), status: 'expired' }
    await expect(harness.service.head(uploadId, 'owner')).rejects.toMatchObject({
      code: 'upload_expired',
      status: 410,
    })
  })

  it('stages, checksums, leases, appends, and completes a chunk', async () => {
    const harness = createHarness()
    await harness.service.create({ length: 5, metadata: [], ownerId: 'owner' })
    const bytes = new TextEncoder().encode('hello')
    const upload = await harness.service.append({
      checksum: { algorithm: 'sha256', digest: createHash('sha256').update(bytes).digest() },
      contentLength: bytes.byteLength,
      offset: 0,
      ownerId: 'owner',
      source: chunks(bytes.subarray(0, 2), bytes.subarray(2)),
      uploadId,
    })

    expect(upload).toMatchObject({ expiresAt: null, offset: 5, status: 'completed' })
    expect(harness.blobs.events).toEqual(['stage', 'reconcile:0', 'append:0', 'discard'])
    expect(harness.repository.acquireInputs[0]).toMatchObject({
      expectedOffset: 0,
      leaseExpiresAt: new Date('2026-08-16T10:00:30.000Z'),
      leaseId,
    })
  })

  it('rejects bad offsets, oversized chunks, and invalid body lengths before writing', async () => {
    const harness = createHarness({ limits: { maximumChunkBytes: 4, maximumUploadBytes: 6 } })
    await harness.service.create({ length: 6, metadata: [], ownerId: 'owner' })

    await expectAppendError(harness, { contentLength: 1, offset: 1 }, 'offset_mismatch', 409)
    await expectAppendError(harness, { contentLength: 5 }, 'upload_too_large', 413)
    await expectAppendError(harness, { contentLength: 0 }, 'invalid_header', 400)

    harness.repository.record = { ...requireRecord(harness.repository.record), length: 2 }
    await expectAppendError(harness, { contentLength: 3 }, 'upload_too_large', 413)
    expect(harness.blobs.events).toEqual([])
  })

  it('rejects truncated streams and checksum mismatches before acquiring a lease', async () => {
    const harness = createHarness()
    await harness.service.create({ length: 5, metadata: [], ownerId: 'owner' })

    await expect(
      harness.service.append({
        contentLength: 5,
        offset: 0,
        ownerId: 'owner',
        source: chunks(new Uint8Array([1, 2])),
        uploadId,
      }),
    ).rejects.toMatchObject({ code: 'invalid_header', status: 400 })

    await expect(
      harness.service.append({
        checksum: { algorithm: 'sha1', digest: new Uint8Array(20) },
        contentLength: 2,
        offset: 0,
        ownerId: 'owner',
        source: chunks(new Uint8Array([1, 2])),
        uploadId,
      }),
    ).rejects.toMatchObject({
      code: 'checksum_mismatch',
      headers: { 'Upload-Offset': '0' },
      status: 460,
    })
    expect(harness.repository.acquireInputs).toHaveLength(0)
    expect(harness.blobs.events).toContain('discard')
  })

  it.each([
    [{ kind: 'conflict', currentOffset: 2 }, 'offset_mismatch', 409],
    [{ kind: 'gone', reason: 'terminated' }, 'upload_terminated', 410],
    [{ kind: 'missing' }, 'upload_not_found', 404],
  ] as const)('maps lease result %o to a protocol response', async (leaseResult, code, status) => {
    const harness = createHarness()
    await harness.service.create({ length: 2, metadata: [], ownerId: 'owner' })
    harness.repository.nextAcquire = leaseResult

    await expectAppendError(harness, { contentLength: 2 }, code, status)
    expect(harness.blobs.events.at(-1)).toBe('discard')
  })

  it('returns Retry-After for an active competing lease', async () => {
    const harness = createHarness()
    await harness.service.create({ length: 2, metadata: [], ownerId: 'owner' })
    harness.repository.nextAcquire = {
      kind: 'locked',
      retryAt: new Date('2026-08-16T10:00:01.100Z'),
    }

    await expectAppendError(harness, { contentLength: 2 }, 'upload_locked', 423, {
      'Retry-After': '2',
    })
  })

  it('releases the lease while preserving an unconfirmed tail for later reconciliation', async () => {
    const harness = createHarness()
    await harness.service.create({ length: 2, metadata: [], ownerId: 'owner' })
    harness.repository.rejectCommit = true
    harness.repository.rejectRelease = true

    await expectAppendError(harness, { contentLength: 2 }, undefined, undefined)
    expect(harness.blobs.events).toContain('append:0')
    expect(harness.repository.releaseInputs).toHaveLength(1)
    expect(harness.repository.record).toMatchObject({ offset: 0, status: 'active' })
  })

  it('terminates resources and maps repeated, missing, and locked termination', async () => {
    const harness = createHarness()
    await harness.service.create({ length: 2, metadata: [], ownerId: 'owner' })
    await harness.service.terminate(uploadId, 'owner')
    expect(harness.blobs.deleted).toContain(uploadId)

    await expect(harness.service.terminate(uploadId, 'owner')).rejects.toMatchObject({
      status: 410,
    })
    harness.repository.record = null
    await expect(harness.service.terminate(uploadId, 'owner')).rejects.toMatchObject({
      status: 404,
    })

    harness.repository.record = record({ leaseExpiresAt: new Date(now.getTime() + 1_000), leaseId })
    await expect(harness.service.terminate(uploadId, 'owner')).rejects.toMatchObject({
      headers: { 'Retry-After': '1' },
      status: 423,
    })
  })

  it('validates its injected clock and lease identifiers', async () => {
    const badClock = createHarness({ clock: () => new Date(Number.NaN) })
    await expect(
      badClock.service.create({ length: 1, metadata: [], ownerId: 'owner' }),
    ).rejects.toThrow('valid Date')

    const harness = createHarness({ ids: [uploadId, 'bad-lease'] })
    await harness.service.create({ length: 1, metadata: [], ownerId: 'owner' })
    await expectAppendError(harness, { contentLength: 1 }, undefined, undefined)
  })

  it('uses production defaults and does not let staging cleanup mask a confirmed upload', async () => {
    const repository = new MemoryRepository()
    const blobs = new MemoryBlobStore()
    blobs.rejectDiscard = true
    const service = createUploadService({ blobStore: blobs, repository })
    const created = await service.create({ length: 1, metadata: [], ownerId: 'owner' })
    const completed = await service.append({
      contentLength: 1,
      offset: 0,
      ownerId: 'owner',
      source: chunks(new Uint8Array([1])),
      uploadId: created.id,
    })

    expect(completed.status).toBe('completed')
    expect(service.limits).toEqual({
      expirationMs: 86_400_000,
      leaseDurationMs: 30_000,
      maximumChunkBytes: 5_242_880,
      maximumUploadBytes: 262_144_000,
    })
  })

  it('applies optional telemetry around the complete service boundary', async () => {
    const events: UploadTelemetryEvent[] = []
    const harness = createHarness({
      monotonicClock: () => 10,
      telemetry: { record: (event) => events.push(event) },
    })

    await harness.service.create({ length: 1, metadata: [], ownerId: 'owner' })

    expect(events).toEqual([
      { kind: 'upload_created' },
      { durationMs: 0, kind: 'operation', operation: 'create', outcome: 'success' },
    ])
  })
})

interface HarnessOptions {
  readonly clock?: () => Date
  readonly ids?: string[]
  readonly limits?: Partial<{
    expirationMs: number
    leaseDurationMs: number
    maximumChunkBytes: number
    maximumUploadBytes: number
  }>
  readonly monotonicClock?: () => number
  readonly telemetry?: UploadTelemetry
}

function createHarness(options: HarnessOptions = {}) {
  const repository = new MemoryRepository()
  const blobs = new MemoryBlobStore()
  const ids = [...(options.ids ?? [uploadId, leaseId])]
  const service = createUploadService({
    blobStore: blobs,
    clock: options.clock ?? (() => now),
    createId: () => ids.shift() ?? leaseId,
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.monotonicClock ? { monotonicClock: options.monotonicClock } : {}),
    repository,
    ...(options.telemetry ? { telemetry: options.telemetry } : {}),
  })
  return { blobs, repository, service }
}

class MemoryRepository implements UploadRepository {
  public acquireInputs: AcquireUploadLeaseInput[] = []
  public createError: Error | null = null
  public nextAcquire: AcquireUploadLeaseResult | null = null
  public record: UploadRecord | null = null
  public rejectCommit = false
  public rejectRelease = false
  public releaseInputs: ReleaseUploadLeaseInput[] = []

  public async create(input: CreateUploadRecordInput): Promise<UploadRecord> {
    if (this.createError) throw this.createError
    this.record = record({
      createdAt: input.now,
      expiresAt: input.expiresAt,
      id: input.id,
      length: input.length,
      metadata: input.metadata,
      ownerId: input.ownerId,
      status: input.length === 0 ? 'completed' : 'active',
      updatedAt: input.now,
    })
    return this.record
  }

  public async findOwned(id: string, ownerId: string, _now: Date): Promise<UploadLookupResult> {
    if (!this.record || this.record.id !== id || this.record.ownerId !== ownerId) {
      return { kind: 'missing' }
    }
    if (this.record.status === 'expired' || this.record.status === 'terminated') {
      return { kind: 'gone', reason: this.record.status }
    }
    return { kind: 'found', upload: this.record }
  }

  public async acquireLease(input: AcquireUploadLeaseInput): Promise<AcquireUploadLeaseResult> {
    this.acquireInputs.push(input)
    if (this.nextAcquire) return this.nextAcquire
    const current = requireRecord(this.record)
    this.record = { ...current, leaseExpiresAt: input.leaseExpiresAt, leaseId: input.leaseId }
    return { kind: 'acquired', upload: this.record }
  }

  public async commitLease(input: CommitUploadLeaseInput): Promise<CommitUploadLeaseResult> {
    if (this.rejectCommit) return { applied: false }
    const current = requireRecord(this.record)
    this.record = {
      ...current,
      expiresAt: input.newOffset === current.length ? null : current.expiresAt,
      leaseExpiresAt: null,
      leaseId: null,
      offset: input.newOffset,
      status: input.newOffset === current.length ? 'completed' : 'active',
      updatedAt: input.now,
    }
    return { applied: true, upload: this.record }
  }

  public async releaseLease(input: ReleaseUploadLeaseInput): Promise<void> {
    this.releaseInputs.push(input)
    if (this.rejectRelease) throw new Error('release failed')
    if (this.record?.leaseId === input.leaseId) {
      this.record = { ...this.record, leaseExpiresAt: null, leaseId: null }
    }
  }

  public async terminate(input: TerminateUploadInput): Promise<TerminateUploadResult> {
    const result = await this.findOwned(input.uploadId, input.ownerId, input.now)
    if (result.kind !== 'found') return result
    if (result.upload.leaseExpiresAt && result.upload.leaseExpiresAt > input.now) {
      return { kind: 'locked', retryAt: result.upload.leaseExpiresAt }
    }
    this.record = { ...result.upload, expiresAt: null, status: 'terminated' }
    return { kind: 'terminated', upload: this.record }
  }
}

class MemoryBlobStore implements UploadBlobStore {
  public created: string[] = []
  public deleted: string[] = []
  public events: string[] = []
  public rejectDelete = false
  public rejectDiscard = false

  public async create(id: string): Promise<void> {
    this.created.push(id)
  }

  public async stage(input: StageUploadChunkInput): Promise<StagedUploadChunk> {
    this.events.push('stage')
    const hash = input.checksumAlgorithm ? createHash(input.checksumAlgorithm) : null
    let length = 0
    for await (const bytes of input.source) {
      length += bytes.byteLength
      hash?.update(bytes)
    }
    if (length !== input.expectedLength) {
      throw new UploadBlobError('length-mismatch', 'length mismatch')
    }
    return { digest: hash?.digest() ?? null, length, token: leaseId }
  }

  public async reconcile(_id: string, offset: number): Promise<void> {
    this.events.push(`reconcile:${offset}`)
  }

  public async append(_id: string, offset: number, _chunk: StagedUploadChunk): Promise<void> {
    this.events.push(`append:${offset}`)
  }

  public async discard(_chunk: StagedUploadChunk): Promise<void> {
    this.events.push('discard')
    if (this.rejectDiscard) throw new Error('discard failed')
  }

  public async delete(id: string): Promise<void> {
    this.deleted.push(id)
    if (this.rejectDelete) throw new Error('delete failed')
  }
}

function record(overrides: Partial<UploadRecord> = {}): UploadRecord {
  return {
    createdAt: now,
    expiresAt: new Date(now.getTime() + 86_400_000),
    id: uploadId,
    leaseExpiresAt: null,
    leaseId: null,
    length: 2,
    metadata: [],
    offset: 0,
    ownerId: 'owner',
    status: 'active',
    updatedAt: now,
    ...overrides,
  }
}

function requireRecord(value: UploadRecord | null): UploadRecord {
  if (!value) throw new Error('Expected record')
  return value
}

async function* chunks(...values: Uint8Array[]): AsyncIterable<Uint8Array> {
  yield* values
}

async function expectAppendError(
  harness: ReturnType<typeof createHarness>,
  overrides: Partial<Parameters<typeof harness.service.append>[0]>,
  code: TusErrorCode | undefined,
  status: number | undefined,
  headers?: Record<string, string>,
): Promise<void> {
  const input = {
    contentLength: 2,
    offset: 0,
    ownerId: 'owner',
    source: chunks(new Uint8Array([1, 2])),
    uploadId,
    ...overrides,
  }
  const expectation = harness.service.append(input)

  if (code === undefined || status === undefined) {
    await expect(expectation).rejects.toBeInstanceOf(Error)
  } else {
    await expect(expectation).rejects.toMatchObject({
      code,
      ...(headers ? { headers } : {}),
      status,
    } satisfies Partial<TusProtocolError>)
  }
}
