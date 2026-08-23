import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createUploadCleanupWorker, createUploadService } from '@resumable-upload-kit/server'
import { registerResumableUploadRoutes } from '@resumable-upload-kit/server/fastify'

import { FileSystemUploadBlobStore } from '../src/filesystem.js'
import { PostgresUploadRepository } from '../src/postgres-repository.js'
import { runUploadMigrations } from '../src/postgres-schema.js'

const databaseUrl = process.env.TEST_DATABASE_URL

if (!databaseUrl) {
  throw new Error('TEST_DATABASE_URL is required for PostgreSQL integration tests')
}

const pool = new Pool({ connectionString: databaseUrl, max: 8 })
const repository = new PostgresUploadRepository(pool)
const now = new Date('2026-08-16T10:00:00.000Z')
const uploadId = '018f1111-1111-7111-8111-111111111111'
const leaseId = '018f2222-2222-7222-8222-222222222222'

beforeAll(async () => {
  await runUploadMigrations(pool)
  await runUploadMigrations(pool)
})

afterAll(async () => {
  await pool.end()
})

describe('PostgreSQL upload persistence', () => {
  beforeEach(async () => {
    await pool.query('TRUNCATE resumable_uploads')
  })

  it('stores ownership, binary-safe metadata, offsets, and completion atomically', async () => {
    const created = await repository.create({
      expiresAt: new Date(now.getTime() + 86_400_000),
      id: uploadId,
      length: 5,
      metadata: [{ key: 'filename', value: new TextEncoder().encode('demo.txt') }],
      now,
      ownerId: 'owner-a',
    })
    expect(created).toMatchObject({ length: 5, offset: 0, status: 'active' })
    expect(new TextDecoder().decode(created.metadata[0]?.value)).toBe('demo.txt')
    await expect(repository.findOwned(uploadId, 'owner-b', now)).resolves.toEqual({
      kind: 'missing',
    })

    const acquired = await repository.acquireLease({
      expectedOffset: 0,
      leaseExpiresAt: new Date(now.getTime() + 30_000),
      leaseId,
      now,
      ownerId: 'owner-a',
      uploadId,
    })
    expect(acquired).toMatchObject({ kind: 'acquired', upload: { leaseId } })

    const committed = await repository.commitLease({
      leaseId,
      newOffset: 5,
      now: new Date(now.getTime() + 1_000),
      ownerId: 'owner-a',
      uploadId,
    })
    expect(committed).toMatchObject({
      applied: true,
      upload: { expiresAt: null, offset: 5, status: 'completed' },
    })
    await expect(
      repository.commitLease({
        leaseId,
        newOffset: 5,
        now,
        ownerId: 'owner-a',
        uploadId,
      }),
    ).resolves.toEqual({ applied: false })
  })

  it('serializes concurrent writers and permits takeover only after lease expiry', async () => {
    await createActiveUpload()
    await repository.acquireLease({
      expectedOffset: 0,
      leaseExpiresAt: new Date(now.getTime() + 30_000),
      leaseId,
      now,
      ownerId: 'owner',
      uploadId,
    })

    await expect(
      repository.acquireLease({
        expectedOffset: 0,
        leaseExpiresAt: new Date(now.getTime() + 31_000),
        leaseId: '018f3333-3333-7333-8333-333333333333',
        now: new Date(now.getTime() + 1_000),
        ownerId: 'owner',
        uploadId,
      }),
    ).resolves.toMatchObject({ kind: 'locked', retryAt: new Date(now.getTime() + 30_000) })

    await expect(
      repository.acquireLease({
        expectedOffset: 0,
        leaseExpiresAt: new Date(now.getTime() + 61_000),
        leaseId: '018f4444-4444-7444-8444-444444444444',
        now: new Date(now.getTime() + 31_000),
        ownerId: 'owner',
        uploadId,
      }),
    ).resolves.toMatchObject({ kind: 'acquired' })
  })

  it('transitions expired and terminated uploads to stable tombstones', async () => {
    await repository.create({
      expiresAt: new Date(now.getTime() - 1),
      id: uploadId,
      length: 5,
      metadata: [],
      now: new Date(now.getTime() - 10_000),
      ownerId: 'owner',
    })
    await expect(repository.findOwned(uploadId, 'owner', now)).resolves.toEqual({
      kind: 'gone',
      reason: 'expired',
    })

    await pool.query('TRUNCATE resumable_uploads')
    await createActiveUpload()
    await expect(repository.terminate({ now, ownerId: 'owner', uploadId })).resolves.toMatchObject({
      kind: 'terminated',
    })
    await expect(repository.terminate({ now, ownerId: 'owner', uploadId })).resolves.toEqual({
      kind: 'gone',
      reason: 'terminated',
    })
  })

  it('claims only eligible uploads and preserves purged tombstones', async () => {
    const claimedUploadId = uploadId
    const leasedUploadId = '018f3333-3333-7333-8333-333333333333'
    await createExpiredUpload(claimedUploadId)
    await createExpiredUpload(leasedUploadId)
    await repository.acquireLease({
      expectedOffset: 0,
      leaseExpiresAt: new Date(now.getTime() + 30_000),
      leaseId,
      now: new Date(now.getTime() - 2_000),
      ownerId: 'owner',
      uploadId: leasedUploadId,
    })
    await repository.create({
      expiresAt: null,
      id: '018f4444-4444-7444-8444-444444444444',
      length: 0,
      metadata: [],
      now,
      ownerId: 'owner',
    })

    const claims = await repository.claimExpired({
      batchSize: 10,
      claimExpiresAt: new Date(now.getTime() + 60_000),
      claimId: '018f5555-5555-7555-8555-555555555555',
      now,
    })

    expect(claims).toEqual([
      {
        claimId: '018f5555-5555-7555-8555-555555555555',
        uploadId: claimedUploadId,
      },
    ])
    await expect(repository.completeCleanup({ ...requireClaim(claims[0]), now })).resolves.toBe(
      true,
    )
    await expect(repository.completeCleanup({ ...requireClaim(claims[0]), now })).resolves.toBe(
      false,
    )
    await expect(repository.findOwned(claimedUploadId, 'owner', now)).resolves.toEqual({
      kind: 'gone',
      reason: 'expired',
    })

    const purged = await pool.query<{ purged_at: Date; status: string }>(
      'SELECT purged_at, status FROM resumable_uploads WHERE id = $1',
      [claimedUploadId],
    )
    expect(purged.rows[0]).toMatchObject({ purged_at: now, status: 'expired' })
  })

  it('coordinates concurrent workers and reclaims abandoned cleanup leases', async () => {
    const ids = [
      uploadId,
      '018f3333-3333-7333-8333-333333333333',
      '018f4444-4444-7444-8444-444444444444',
    ]
    await Promise.all(ids.map(createExpiredUpload))
    const claimExpiresAt = new Date(now.getTime() + 1_000)
    const [first, second] = await Promise.all([
      repository.claimExpired({
        batchSize: 2,
        claimExpiresAt,
        claimId: '018f5555-5555-7555-8555-555555555555',
        now,
      }),
      repository.claimExpired({
        batchSize: 2,
        claimExpiresAt,
        claimId: '018f6666-6666-7666-8666-666666666666',
        now,
      }),
    ])

    expect(new Set([...first, ...second].map((claim) => claim.uploadId))).toEqual(new Set(ids))
    await expect(
      repository.claimExpired({
        batchSize: 3,
        claimExpiresAt,
        claimId: '018f7777-7777-7777-8777-777777777777',
        now,
      }),
    ).resolves.toHaveLength(0)

    const retryAt = new Date(claimExpiresAt.getTime() + 1)
    const retried = await repository.claimExpired({
      batchSize: 3,
      claimExpiresAt: new Date(retryAt.getTime() + 1_000),
      claimId: '018f7777-7777-7777-8777-777777777777',
      now: retryAt,
    })
    expect(new Set(retried.map((claim) => claim.uploadId))).toEqual(new Set(ids))
    await repository.releaseCleanup({ ...requireClaim(retried[0]), now: retryAt })

    const attempts = await pool.query<{ cleanup_attempts: number }>(
      'SELECT cleanup_attempts FROM resumable_uploads',
    )
    expect(attempts.rows.every((row) => row.cleanup_attempts === 2)).toBe(true)
  })

  async function createActiveUpload(): Promise<void> {
    await repository.create({
      expiresAt: new Date(now.getTime() + 86_400_000),
      id: uploadId,
      length: 5,
      metadata: [],
      now,
      ownerId: 'owner',
    })
  }

  async function createExpiredUpload(id: string): Promise<void> {
    await repository.create({
      expiresAt: new Date(now.getTime() - 1_000),
      id,
      length: 5,
      metadata: [],
      now: new Date(now.getTime() - 10_000),
      ownerId: 'owner',
    })
  }
})

describe('durable cleanup path', () => {
  let root: string

  beforeEach(async () => {
    await pool.query('TRUNCATE resumable_uploads')
    root = await mkdtemp(join(tmpdir(), 'resumable-upload-kit-cleanup-'))
  })

  afterEach(async () => {
    await rm(root, { force: true, recursive: true })
  })

  it('deletes an expired blob and keeps its database tombstone', async () => {
    const blobStore = new FileSystemUploadBlobStore({ rootDirectory: root })
    await blobStore.create(uploadId)
    await repository.create({
      expiresAt: new Date(now.getTime() - 1),
      id: uploadId,
      length: 5,
      metadata: [],
      now: new Date(now.getTime() - 10_000),
      ownerId: 'owner',
    })
    const worker = createUploadCleanupWorker({
      blobStore,
      clock: () => now,
      createClaimId: () => '018f5555-5555-7555-8555-555555555555',
      repository,
    })

    await expect(worker.runOnce()).resolves.toEqual({ claimed: 1, cleaned: 1, failed: 0 })
    await expect(stat(join(root, 'objects', uploadId))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(repository.findOwned(uploadId, 'owner', now)).resolves.toEqual({
      kind: 'gone',
      reason: 'expired',
    })
  })
})

describe('durable Fastify upload path', () => {
  const roots: string[] = []
  const apps: FastifyInstance[] = []

  beforeEach(async () => {
    await pool.query('TRUNCATE resumable_uploads')
  })

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()))
    await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
  })

  it('recovers an orphaned blob tail and confirms the retried HTTP chunk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'resumable-upload-kit-integration-'))
    roots.push(root)
    const stageIds = [
      '018f3333-3333-7333-8333-333333333333',
      '018f4444-4444-7444-8444-444444444444',
    ]
    const blobStore = new FileSystemUploadBlobStore({
      createStageId: () => stageIds.shift() ?? '018f5555-5555-7555-8555-555555555555',
      rootDirectory: root,
    })
    const ids = [uploadId, leaseId]
    const service = createUploadService({
      blobStore,
      clock: () => now,
      createId: () => ids.shift() ?? '018f6666-6666-7666-8666-666666666666',
      repository,
    })
    const app = Fastify()
    apps.push(app)
    registerResumableUploadRoutes(app, {
      resolveOwner: () => 'owner',
      service,
    })
    await app.ready()

    const createResponse = await app.inject({
      headers: { 'tus-resumable': '1.0.0', 'upload-length': '5' },
      method: 'POST',
      url: '/uploads',
    })
    expect(createResponse.statusCode).toBe(201)

    const orphan = await blobStore.stage({
      expectedLength: 3,
      source: chunks(new TextEncoder().encode('old')),
      uploadId,
    })
    await blobStore.append(uploadId, 0, orphan)
    await blobStore.discard(orphan)

    const patchResponse = await app.inject({
      headers: {
        'content-length': '5',
        'content-type': 'application/offset+octet-stream',
        'tus-resumable': '1.0.0',
        'upload-offset': '0',
      },
      method: 'PATCH',
      payload: Buffer.from('hello'),
      url: `/uploads/${uploadId}`,
    })
    expect(patchResponse.statusCode).toBe(204)
    expect(patchResponse.headers['upload-offset']).toBe('5')
    expect(await readFile(join(root, 'objects', uploadId), 'utf8')).toBe('hello')

    const headResponse = await app.inject({
      headers: { 'tus-resumable': '1.0.0' },
      method: 'HEAD',
      url: `/uploads/${uploadId}`,
    })
    expect(headResponse.headers).toMatchObject({ 'upload-length': '5', 'upload-offset': '5' })
  })
})

async function* chunks(...values: Uint8Array[]): AsyncIterable<Uint8Array> {
  yield* values
}

function requireClaim<T>(claim: T | undefined): T {
  if (!claim) throw new Error('Expected cleanup claim')
  return claim
}
