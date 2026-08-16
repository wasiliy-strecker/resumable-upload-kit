import { createHash } from 'node:crypto'
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { UploadBlobError } from '@resumable-upload-kit/server'

import { FileSystemUploadBlobStore } from '../src/filesystem.js'

const uploadId = '018f1111-1111-7111-8111-111111111111'
const secondUploadId = '018f2222-2222-7222-8222-222222222222'
const stageIds = [
  '018f3333-3333-7333-8333-333333333333',
  '018f4444-4444-7444-8444-444444444444',
  '018f5555-5555-7555-8555-555555555555',
]

describe('FileSystemUploadBlobStore', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
  })

  it('creates private opaque objects and appends a staged streaming chunk', async () => {
    const { root, store } = await createStore()
    await store.create(uploadId)
    const bytes = new TextEncoder().encode('hello')
    const staged = await store.stage({
      checksumAlgorithm: 'sha256',
      expectedLength: bytes.byteLength,
      source: chunks(bytes.subarray(0, 2), bytes.subarray(2)),
      uploadId,
    })

    expect(staged).toMatchObject({ length: 5, token: stageIds[0] })
    expect(Buffer.from(staged.digest ?? [])).toEqual(createHash('sha256').update(bytes).digest())
    await store.append(uploadId, 0, staged)
    await store.discard(staged)

    const objectPath = join(root, 'objects', uploadId)
    expect(await readFile(objectPath, 'utf8')).toBe('hello')
    expect((await stat(objectPath)).mode & 0o777).toBe(0o600)
    await expect(stat(join(root, 'staging', `${stageIds[0]}.chunk`))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('truncates an unconfirmed crash tail to the PostgreSQL offset', async () => {
    const { root, store } = await createStore()
    await store.create(uploadId)
    await appendFile(join(root, 'objects', uploadId), 'confirmed-orphaned')

    await store.reconcile(uploadId, 9)

    expect(await readFile(join(root, 'objects', uploadId), 'utf8')).toBe('confirmed')
  })

  it('treats missing and shorter-than-confirmed objects as corruption', async () => {
    const { root, store } = await createStore()

    await expect(store.reconcile(uploadId, 0)).rejects.toMatchObject({ reason: 'corrupt' })
    await store.create(uploadId)
    await writeFile(join(root, 'objects', uploadId), 'tiny')
    await expect(store.reconcile(uploadId, 5)).rejects.toBeInstanceOf(UploadBlobError)
    await expect(store.reconcile(uploadId, 4)).resolves.toBeUndefined()
  })

  it('rejects shorter and longer streams and removes their staging files', async () => {
    const { root, store } = await createStore()
    await store.create(uploadId)

    await expect(
      store.stage({ expectedLength: 3, source: chunks(new Uint8Array([1, 2])), uploadId }),
    ).rejects.toMatchObject({ reason: 'length-mismatch' })
    await expect(
      store.stage({ expectedLength: 1, source: chunks(new Uint8Array([1, 2])), uploadId }),
    ).rejects.toMatchObject({ reason: 'length-mismatch' })
    await expect(stat(join(root, 'staging', `${stageIds[0]}.chunk`))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(stat(join(root, 'staging', `${stageIds[1]}.chunk`))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('detects modified staging files before appending', async () => {
    const { root, store } = await createStore()
    await store.create(uploadId)
    const staged = await store.stage({
      expectedLength: 2,
      source: chunks(new Uint8Array([1, 2])),
      uploadId,
    })
    await writeFile(join(root, 'staging', `${staged.token}.chunk`), new Uint8Array([1]))

    await expect(store.append(uploadId, 0, staged)).rejects.toMatchObject({ reason: 'corrupt' })
    await store.discard(staged)
  })

  it('deletes objects idempotently while leaving unrelated uploads intact', async () => {
    const { root, store } = await createStore()
    await store.create(uploadId)
    await store.create(secondUploadId)

    await store.delete(uploadId)
    await store.delete(uploadId)

    await expect(stat(join(root, 'objects', uploadId))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(root, 'objects', secondUploadId))).resolves.toBeDefined()
  })

  it('rejects unsafe paths, offsets, stage tokens, and non-byte sources', async () => {
    expect(() => new FileSystemUploadBlobStore({ rootDirectory: ' ' })).toThrow('must not be empty')
    const root = await mkdtemp(join(tmpdir(), 'resumable-upload-kit-'))
    roots.push(root)
    const invalidStageStore = new FileSystemUploadBlobStore({
      createStageId: () => '../escape',
      rootDirectory: root,
    })

    await expect(invalidStageStore.create('../escape')).rejects.toThrow('uploadId')
    await expect(invalidStageStore.reconcile(uploadId, -1)).rejects.toThrow('offset')
    await expect(
      invalidStageStore.stage({ expectedLength: 1, source: chunks(new Uint8Array([1])), uploadId }),
    ).rejects.toThrow('stage token')

    const validStore = new FileSystemUploadBlobStore({
      createStageId: () => stageIds[0] ?? '',
      rootDirectory: root,
    })
    await expect(
      validStore.stage({ expectedLength: 0, source: chunks(), uploadId }),
    ).rejects.toMatchObject({ reason: 'length-mismatch' })
    await expect(
      validStore.stage({
        expectedLength: 1,
        source: invalidChunks(),
        uploadId,
      }),
    ).rejects.toBeInstanceOf(TypeError)
  })

  async function createStore() {
    const root = await mkdtemp(join(tmpdir(), 'resumable-upload-kit-'))
    roots.push(root)
    const ids = [...stageIds]
    return {
      root,
      store: new FileSystemUploadBlobStore({
        createStageId: () => ids.shift() ?? stageIds.at(-1) ?? '',
        rootDirectory: root,
      }),
    }
  }
})

async function* chunks(...values: Uint8Array[]): AsyncIterable<Uint8Array> {
  yield* values
}

async function* invalidChunks(): AsyncIterable<Uint8Array> {
  yield 'not bytes' as unknown as Uint8Array
}
