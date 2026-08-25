import { randomUUID, timingSafeEqual } from 'node:crypto'

import { TusProtocolError, tusHeader } from '@resumable-upload-kit/protocol'

import {
  UploadBlobError,
  type AcquireUploadLeaseResult,
  type AppendUploadInput,
  type CreateUploadInput,
  type CreateUploadServiceOptions,
  type GoneReason,
  type StagedUploadChunk,
  type UploadLimits,
  type UploadLookupResult,
  type UploadRecord,
  type UploadService,
} from './types.js'
import { instrumentUploadService } from './telemetry.js'

export const defaultUploadLimits: UploadLimits = Object.freeze({
  expirationMs: 24 * 60 * 60 * 1_000,
  leaseDurationMs: 30_000,
  maximumChunkBytes: 5 * 1_024 * 1_024,
  maximumUploadBytes: 250 * 1_024 * 1_024,
})

const ownerIdMaximumLength = 200
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

export function createUploadService(options: CreateUploadServiceOptions): UploadService {
  const limits = resolveLimits(options.limits)
  const clock = options.clock ?? (() => new Date())
  const createId = options.createId ?? randomUUID

  const service: UploadService = {
    limits,

    async create(input: CreateUploadInput): Promise<UploadRecord> {
      assertOwner(input.ownerId)
      assertUploadLength(input.length, limits.maximumUploadBytes)
      const id = createId()

      if (!uuidPattern.test(id)) {
        throw new Error('Upload identifiers must be lowercase RFC 9562 UUIDs')
      }

      const now = validDate(clock(), 'clock')
      const expiresAt = input.length === 0 ? null : new Date(now.getTime() + limits.expirationMs)
      await options.blobStore.create(id)

      try {
        return await options.repository.create({
          expiresAt,
          id,
          length: input.length,
          metadata: input.metadata,
          now,
          ownerId: input.ownerId,
        })
      } catch (error) {
        await options.blobStore.delete(id).catch(() => undefined)
        throw error
      }
    },

    async head(uploadId: string, ownerId: string): Promise<UploadRecord> {
      assertOwner(ownerId)
      assertUploadId(uploadId)
      return requireFound(
        await options.repository.findOwned(uploadId, ownerId, validDate(clock(), 'clock')),
      )
    },

    async append(input: AppendUploadInput): Promise<UploadRecord> {
      assertOwner(input.ownerId)
      assertUploadId(input.uploadId)
      assertChunkLength(input.contentLength, limits.maximumChunkBytes)
      const now = validDate(clock(), 'clock')
      const existing = requireFound(
        await options.repository.findOwned(input.uploadId, input.ownerId, now),
      )

      if (existing.status !== 'active' || existing.offset !== input.offset) {
        throw offsetConflict(existing.offset)
      }

      if (input.contentLength > existing.length - existing.offset) {
        throw new TusProtocolError({
          code: 'upload_too_large',
          message: 'Chunk exceeds the remaining upload length',
          status: 413,
        })
      }

      let staged: StagedUploadChunk

      try {
        staged = await options.blobStore.stage({
          ...(input.checksum ? { checksumAlgorithm: input.checksum.algorithm } : {}),
          expectedLength: input.contentLength,
          source: input.source,
          uploadId: input.uploadId,
        })
      } catch (error) {
        if (error instanceof UploadBlobError && error.reason === 'length-mismatch') {
          throw new TusProtocolError({
            cause: error,
            code: 'invalid_header',
            message: 'Content-Length does not match the received chunk bytes',
            status: 400,
          })
        }

        throw error
      }

      try {
        assertChecksum(input, staged)
        const leaseId = createId()

        if (!uuidPattern.test(leaseId)) {
          throw new Error('Lease identifiers must be lowercase RFC 9562 UUIDs')
        }

        const leaseNow = validDate(clock(), 'clock')
        const lease = await options.repository.acquireLease({
          expectedOffset: input.offset,
          leaseExpiresAt: new Date(leaseNow.getTime() + limits.leaseDurationMs),
          leaseId,
          now: leaseNow,
          ownerId: input.ownerId,
          uploadId: input.uploadId,
        })

        return await commitStagedChunk(options, input, staged, leaseId, lease, clock)
      } finally {
        await options.blobStore.discard(staged).catch(() => undefined)
      }
    },

    async terminate(uploadId: string, ownerId: string): Promise<void> {
      assertOwner(ownerId)
      assertUploadId(uploadId)
      const result = await options.repository.terminate({
        now: validDate(clock(), 'clock'),
        ownerId,
        uploadId,
      })

      switch (result.kind) {
        case 'terminated':
          await options.blobStore.delete(uploadId)
          return
        case 'locked':
          throw locked(result.retryAt, clock())
        case 'gone':
          throw gone(result.reason)
        case 'missing':
          throw notFound()
      }
    },
  }

  return options.telemetry
    ? instrumentUploadService(service, {
        ...(options.monotonicClock ? { monotonicClock: options.monotonicClock } : {}),
        telemetry: options.telemetry,
      })
    : service
}

async function commitStagedChunk(
  options: CreateUploadServiceOptions,
  input: AppendUploadInput,
  staged: StagedUploadChunk,
  leaseId: string,
  lease: AcquireUploadLeaseResult,
  clock: () => Date,
): Promise<UploadRecord> {
  switch (lease.kind) {
    case 'conflict':
      throw offsetConflict(lease.currentOffset)
    case 'gone':
      throw gone(lease.reason)
    case 'locked':
      throw locked(lease.retryAt, clock())
    case 'missing':
      throw notFound()
    case 'acquired':
      break
  }

  let committed = false

  try {
    await options.blobStore.reconcile(input.uploadId, lease.upload.offset)
    await options.blobStore.append(input.uploadId, lease.upload.offset, staged)
    const result = await options.repository.commitLease({
      leaseId,
      newOffset: lease.upload.offset + staged.length,
      now: validDate(clock(), 'clock'),
      ownerId: input.ownerId,
      uploadId: input.uploadId,
    })

    if (!result.applied) {
      throw new Error('Upload lease was lost after the blob append')
    }

    committed = true
    return result.upload
  } finally {
    if (!committed) {
      await options.repository
        .releaseLease({
          leaseId,
          now: validDate(clock(), 'clock'),
          ownerId: input.ownerId,
          uploadId: input.uploadId,
        })
        .catch(() => undefined)
    }
  }
}

function assertChecksum(input: AppendUploadInput, staged: StagedUploadChunk): void {
  if (!input.checksum) {
    return
  }

  const actual = staged.digest
  const expected = input.checksum.digest

  if (
    actual === null ||
    actual.byteLength !== expected.byteLength ||
    !timingSafeEqual(actual, expected)
  ) {
    throw new TusProtocolError({
      code: 'checksum_mismatch',
      headers: { [tusHeader.uploadOffset]: String(input.offset) },
      message: 'Chunk checksum does not match Upload-Checksum',
      status: 460,
    })
  }
}

function requireFound(result: UploadLookupResult): UploadRecord {
  switch (result.kind) {
    case 'found':
      return result.upload
    case 'gone':
      throw gone(result.reason)
    case 'missing':
      throw notFound()
  }
}

function resolveLimits(input: Partial<UploadLimits> | undefined): UploadLimits {
  const limits = Object.freeze({ ...defaultUploadLimits, ...input })

  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`${name} must be a positive safe integer`)
    }
  }

  if (limits.maximumChunkBytes > limits.maximumUploadBytes) {
    throw new Error('maximumChunkBytes must not exceed maximumUploadBytes')
  }

  return limits
}

function assertUploadLength(length: number, maximum: number): void {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new TusProtocolError({
      code: 'invalid_header',
      message: 'Upload-Length must be a non-negative safe integer',
      status: 400,
    })
  }

  if (length > maximum) {
    throw new TusProtocolError({
      code: 'upload_too_large',
      message: `Upload-Length exceeds ${maximum} bytes`,
      status: 413,
    })
  }
}

function assertChunkLength(length: number, maximum: number): void {
  if (!Number.isSafeInteger(length) || length < 1) {
    throw new TusProtocolError({
      code: 'invalid_header',
      message: 'Content-Length must be a positive safe integer for PATCH',
      status: 400,
    })
  }

  if (length > maximum) {
    throw new TusProtocolError({
      code: 'upload_too_large',
      message: `Chunk exceeds ${maximum} bytes`,
      status: 413,
    })
  }
}

function assertOwner(ownerId: string): void {
  if (ownerId.length < 1 || ownerId.length > ownerIdMaximumLength || ownerId.trim() !== ownerId) {
    throw new TusProtocolError({
      code: 'unauthorized',
      message: 'A valid upload owner is required',
      status: 401,
    })
  }
}

function assertUploadId(uploadId: string): void {
  if (!uuidPattern.test(uploadId)) {
    throw notFound()
  }
}

function validDate(value: Date, name: string): Date {
  if (!Number.isFinite(value.getTime())) {
    throw new Error(`${name} must return a valid Date`)
  }

  return value
}

function offsetConflict(offset: number): TusProtocolError {
  return new TusProtocolError({
    code: 'offset_mismatch',
    headers: { [tusHeader.uploadOffset]: String(offset) },
    message: `Upload-Offset does not match the confirmed offset ${offset}`,
    status: 409,
  })
}

function locked(retryAt: Date, now: Date): TusProtocolError {
  const retryAfter = Math.max(1, Math.ceil((retryAt.getTime() - now.getTime()) / 1_000))
  return new TusProtocolError({
    code: 'upload_locked',
    headers: { 'Retry-After': String(retryAfter) },
    message: 'Another request currently owns the upload lease',
    status: 423,
  })
}

function gone(reason: GoneReason): TusProtocolError {
  return new TusProtocolError({
    code: reason === 'expired' ? 'upload_expired' : 'upload_terminated',
    message: reason === 'expired' ? 'Upload has expired' : 'Upload has been terminated',
    status: 410,
  })
}

function notFound(): TusProtocolError {
  return new TusProtocolError({
    code: 'upload_not_found',
    message: 'Upload does not exist',
    status: 404,
  })
}
