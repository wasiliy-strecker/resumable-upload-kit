import { cloneCheckpoint } from './memory-store.js'
import type { UploadCheckpoint, UploadCheckpointStore } from './types.js'

export interface IndexedDbUploadCheckpointStoreOptions {
  readonly databaseName?: string
  readonly indexedDB?: IDBFactory
}

const databaseVersion = 1
const objectStoreName = 'checkpoints'

export class IndexedDbUploadCheckpointStore implements UploadCheckpointStore {
  readonly #databaseName: string
  readonly #indexedDB: IDBFactory
  #databasePromise: Promise<IDBDatabase> | null = null

  public constructor(options: IndexedDbUploadCheckpointStoreOptions = {}) {
    const indexedDB = options.indexedDB ?? globalThis.indexedDB

    if (!indexedDB) {
      throw new Error('IndexedDB is not available in this runtime')
    }

    this.#databaseName = options.databaseName ?? 'resumable-upload-kit'
    this.#indexedDB = indexedDB
  }

  public async delete(id: string): Promise<void> {
    const database = await this.#database()
    const transaction = database.transaction(objectStoreName, 'readwrite')
    transaction.objectStore(objectStoreName).delete(id)
    await transactionDone(transaction)
  }

  public async get(id: string): Promise<UploadCheckpoint | null> {
    const database = await this.#database()
    const transaction = database.transaction(objectStoreName, 'readonly')
    const request = transaction.objectStore(objectStoreName).get(id) as IDBRequest<
      UploadCheckpoint | undefined
    >
    const value = await requestResult(request)
    await transactionDone(transaction)
    return value ? cloneCheckpoint(value) : null
  }

  public async list(): Promise<readonly UploadCheckpoint[]> {
    const database = await this.#database()
    const transaction = database.transaction(objectStoreName, 'readonly')
    const request = transaction.objectStore(objectStoreName).getAll() as IDBRequest<
      UploadCheckpoint[]
    >
    const values = await requestResult(request)
    await transactionDone(transaction)
    return values
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(cloneCheckpoint)
  }

  public async put(checkpoint: UploadCheckpoint): Promise<void> {
    const database = await this.#database()
    const transaction = database.transaction(objectStoreName, 'readwrite')
    transaction.objectStore(objectStoreName).put(cloneCheckpoint(checkpoint))
    await transactionDone(transaction)
  }

  public close(): void {
    void this.#databasePromise?.then((database) => database.close())
    this.#databasePromise = null
  }

  async #database(): Promise<IDBDatabase> {
    if (!this.#databasePromise) {
      this.#databasePromise = openDatabase(this.#indexedDB, this.#databaseName).catch((error) => {
        this.#databasePromise = null
        throw error
      })
    }

    return this.#databasePromise
  }
}

function openDatabase(indexedDB: IDBFactory, databaseName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, databaseVersion)

    request.addEventListener('upgradeneeded', () => {
      const database = request.result

      if (!database.objectStoreNames.contains(objectStoreName)) {
        database.createObjectStore(objectStoreName, { keyPath: 'id' })
      }
    })
    request.addEventListener('success', () => resolve(request.result))
    request.addEventListener('error', () =>
      reject(request.error ?? new Error('IndexedDB open failed')),
    )
    request.addEventListener('blocked', () => reject(new Error('IndexedDB upgrade is blocked')))
  })
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result))
    request.addEventListener('error', () =>
      reject(request.error ?? new Error('IndexedDB request failed')),
    )
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve())
    transaction.addEventListener('abort', () =>
      reject(transaction.error ?? new Error('IndexedDB transaction aborted')),
    )
    transaction.addEventListener('error', () =>
      reject(transaction.error ?? new Error('IndexedDB transaction failed')),
    )
  })
}
