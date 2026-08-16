import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createUploadService } from '@resumable-upload-kit/server'
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
