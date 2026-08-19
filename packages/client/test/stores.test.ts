import { IDBFactory } from 'fake-indexeddb'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { IndexedDbUploadCheckpointStore } from '../src/indexeddb-store.js'
import { MemoryUploadCheckpointStore, cloneCheckpoint } from '../src/memory-store.js'
import type { UploadCheckpoint, UploadCheckpointStore } from '../src/types.js'

describe.each([
  ['memory', () => new MemoryUploadCheckpointStore()],
  [
    'IndexedDB',
    () =>
      new IndexedDbUploadCheckpointStore({
        databaseName: `resumable-upload-kit-${crypto.randomUUID()}`,
        indexedDB: new IDBFactory(),
      }),
  ],
] as const)('%s checkpoint store', (_name, createStore) => {
  let store: UploadCheckpointStore | null = null

  afterEach(() => {
    if (store instanceof IndexedDbUploadCheckpointStore) store.close()
    store = null
  })

  it('round-trips, sorts, replaces, and deletes immutable checkpoints', async () => {
    store = createStore()
    const older = checkpoint({ id: 'older', updatedAt: '2026-08-19T09:00:00.000Z' })
    const newer = checkpoint({ id: 'newer', updatedAt: '2026-08-19T11:00:00.000Z' })
    await store.put(older)
    await store.put(newer)

    const listed = await store.list()
    expect(listed.map(({ id }) => id)).toEqual(['newer', 'older'])
    expect(Object.isFrozen(listed[0])).toBe(true)
    const firstByte = listed[0]?.metadata[0]?.value[0]
    if (listed[0]?.metadata[0]) listed[0].metadata[0].value[0] = 255
    expect((await store.get('newer'))?.metadata[0]?.value[0]).toBe(firstByte)

    await store.put(checkpoint({ confirmedOffset: 2, id: 'older' }))
    expect(await store.get('older')).toMatchObject({ confirmedOffset: 2 })
    await store.delete('older')
    await store.delete('missing')
    expect(await store.get('older')).toBeNull()
  })
})

describe('IndexedDbUploadCheckpointStore lifecycle', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reopens the same database without losing checkpoints', async () => {
    const indexedDB = new IDBFactory()
    const first = new IndexedDbUploadCheckpointStore({ databaseName: 'persistent', indexedDB })
    await first.put(checkpoint())
    first.close()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const second = new IndexedDbUploadCheckpointStore({ databaseName: 'persistent', indexedDB })
    await expect(second.get('checkpoint-1')).resolves.toMatchObject({ id: 'checkpoint-1' })
    second.close()
  })

  it('uses global IndexedDB by default and reports unavailable runtimes', async () => {
    const indexedDB = new IDBFactory()
    vi.stubGlobal('indexedDB', indexedDB)
    const store = new IndexedDbUploadCheckpointStore({ databaseName: 'global-factory' })
    await store.put(checkpoint())
    expect(await store.list()).toHaveLength(1)
    store.close()

    vi.stubGlobal('indexedDB', undefined)
    expect(() => new IndexedDbUploadCheckpointStore()).toThrow('not available')
  })

  it('clears a failed open promise so a later call can retry', async () => {
    const indexedDB = new IDBFactory()
    const newer = await openDatabase(indexedDB, 'newer-schema', 2)
    newer.close()
    const store = new IndexedDbUploadCheckpointStore({
      databaseName: 'newer-schema',
      indexedDB,
    })

    await expect(store.get('missing')).rejects.toBeDefined()
    await expect(store.get('missing')).rejects.toBeDefined()
    store.close()
  })
})

describe('checkpoint cloning', () => {
  it('copies binary metadata instead of sharing mutable arrays', () => {
    const original = checkpoint()
    const cloned = cloneCheckpoint(original)
    original.metadata[0]!.value[0] = 255
    expect(cloned.metadata[0]?.value[0]).toBe(100)
  })
})

function checkpoint(overrides: Partial<UploadCheckpoint> = {}): UploadCheckpoint {
  return {
    confirmedOffset: 0,
    createdAt: '2026-08-19T10:00:00.000Z',
    expiresAt: null,
    id: 'checkpoint-1',
    lastErrorCode: null,
    metadata: [{ key: 'filename', value: new Uint8Array([100, 101, 109, 111]) }],
    phase: 'active',
    size: 4,
    sourceFingerprint: 'file-a',
    updatedAt: '2026-08-19T10:00:00.000Z',
    uploadUrl: 'https://uploads.example.test/uploads/remote-1',
    ...overrides,
  }
}

function openDatabase(indexedDB: IDBFactory, name: string, version: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version)
    request.addEventListener('success', () => resolve(request.result))
    request.addEventListener('error', () =>
      reject(request.error ?? new Error('Database open failed')),
    )
  })
}
