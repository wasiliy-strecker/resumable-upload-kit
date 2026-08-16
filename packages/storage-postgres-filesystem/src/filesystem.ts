import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import {
  UploadBlobError,
  type StageUploadChunkInput,
  type StagedUploadChunk,
  type UploadBlobStore,
} from '@resumable-upload-kit/server'

export interface FileSystemUploadBlobStoreOptions {
  readonly createStageId?: () => string
  readonly rootDirectory: string
}

const copyBufferBytes = 64 * 1_024
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

/**
 * Stores opaque upload bytes without ever deriving paths from user metadata.
 * Chunks are staged first so length and checksum validation finish before a
 * database lease is acquired.
 */
export class FileSystemUploadBlobStore implements UploadBlobStore {
  readonly #createStageId: () => string
  readonly #objectsDirectory: string
  readonly #stagingDirectory: string

  public constructor(options: FileSystemUploadBlobStoreOptions) {
    if (options.rootDirectory.trim().length === 0) {
      throw new Error('rootDirectory must not be empty')
    }

    const rootDirectory = resolve(options.rootDirectory)
    this.#objectsDirectory = join(rootDirectory, 'objects')
    this.#stagingDirectory = join(rootDirectory, 'staging')
    this.#createStageId = options.createStageId ?? randomUUID
  }

  public async create(uploadId: string): Promise<void> {
    assertUuid(uploadId, 'uploadId')
    await this.#ensureDirectories()
    const file = await open(this.#objectPath(uploadId), 'wx', 0o600)

    try {
      await file.sync()
    } finally {
      await file.close()
    }
  }

  public async stage(input: StageUploadChunkInput): Promise<StagedUploadChunk> {
    assertUuid(input.uploadId, 'uploadId')

    if (!Number.isSafeInteger(input.expectedLength) || input.expectedLength < 1) {
      throw new UploadBlobError('length-mismatch', 'Expected chunk length must be positive')
    }

    await this.#ensureDirectories()
    const token = this.#createStageId()
    assertUuid(token, 'stage token')
    const path = this.#stagePath(token)
    const file = await open(path, 'wx', 0o600)
    const hash = input.checksumAlgorithm ? createHash(input.checksumAlgorithm) : null
    let length = 0

    try {
      for await (const chunk of input.source) {
        if (!(chunk instanceof Uint8Array)) {
          throw new TypeError('Upload chunk sources must yield Uint8Array values')
        }

        length += chunk.byteLength

        if (length > input.expectedLength) {
          throw new UploadBlobError(
            'length-mismatch',
            'Received more chunk bytes than Content-Length declared',
          )
        }

        await writeFully(file, chunk, length - chunk.byteLength)
        hash?.update(chunk)
      }

      if (length !== input.expectedLength) {
        throw new UploadBlobError(
          'length-mismatch',
          'Received fewer chunk bytes than Content-Length declared',
        )
      }

      await file.sync()
      return Object.freeze({
        digest: hash?.digest() ?? null,
        length,
        token,
      })
    } catch (error) {
      await file.close().catch(() => undefined)
      await rm(path, { force: true }).catch(() => undefined)
      throw error
    } finally {
      await file.close().catch(() => undefined)
    }
  }

  public async reconcile(uploadId: string, confirmedOffset: number): Promise<void> {
    assertUuid(uploadId, 'uploadId')
    assertOffset(confirmedOffset)

    try {
      const file = await open(this.#objectPath(uploadId), 'r+')

      try {
        const { size } = await file.stat()

        if (size < confirmedOffset) {
          throw new UploadBlobError(
            'corrupt',
            `Blob contains ${size} bytes but PostgreSQL confirms ${confirmedOffset}`,
          )
        }

        if (size > confirmedOffset) {
          await file.truncate(confirmedOffset)
          await file.sync()
        }
      } finally {
        await file.close()
      }
    } catch (error) {
      if (error instanceof UploadBlobError) {
        throw error
      }

      throw new UploadBlobError('corrupt', 'Upload blob is missing or unreadable', { cause: error })
    }
  }

  public async append(uploadId: string, offset: number, chunk: StagedUploadChunk): Promise<void> {
    assertUuid(uploadId, 'uploadId')
    assertUuid(chunk.token, 'stage token')
    assertOffset(offset)

    const object = await open(this.#objectPath(uploadId), 'r+')

    try {
      const staged = await open(this.#stagePath(chunk.token), 'r')

      try {
        const stagedSize = (await staged.stat()).size

        if (stagedSize !== chunk.length) {
          throw new UploadBlobError('corrupt', 'Staged chunk size changed before append')
        }

        const buffer = Buffer.allocUnsafe(Math.min(copyBufferBytes, Math.max(1, chunk.length)))
        let position = 0

        while (position < chunk.length) {
          const requested = Math.min(buffer.byteLength, chunk.length - position)
          const { bytesRead } = await staged.read(buffer, 0, requested, position)

          if (bytesRead === 0) {
            throw new UploadBlobError('corrupt', 'Staged chunk ended before its recorded length')
          }

          await writeFully(object, buffer.subarray(0, bytesRead), offset + position)
          position += bytesRead
        }

        await object.sync()
      } finally {
        await staged.close()
      }
    } finally {
      await object.close()
    }
  }

  public async discard(chunk: StagedUploadChunk): Promise<void> {
    assertUuid(chunk.token, 'stage token')
    await rm(this.#stagePath(chunk.token), { force: true })
  }

  public async delete(uploadId: string): Promise<void> {
    assertUuid(uploadId, 'uploadId')
    await rm(this.#objectPath(uploadId), { force: true })
  }

  async #ensureDirectories(): Promise<void> {
    await Promise.all([
      mkdir(this.#objectsDirectory, { recursive: true }),
      mkdir(this.#stagingDirectory, { recursive: true }),
    ])
  }

  #objectPath(uploadId: string): string {
    return join(this.#objectsDirectory, uploadId)
  }

  #stagePath(token: string): string {
    return join(this.#stagingDirectory, `${token}.chunk`)
  }
}

function assertUuid(value: string, name: string): void {
  if (!uuidPattern.test(value)) {
    throw new Error(`${name} must be a lowercase RFC 9562 UUID`)
  }
}

function assertOffset(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('offset must be a non-negative safe integer')
  }
}

async function writeFully(
  file: Awaited<ReturnType<typeof open>>,
  bytes: Uint8Array,
  position: number,
): Promise<void> {
  let written = 0

  while (written < bytes.byteLength) {
    const result = await file.write(bytes, written, bytes.byteLength - written, position + written)

    if (result.bytesWritten === 0) {
      throw new UploadBlobError('corrupt', 'Filesystem stopped accepting upload bytes')
    }

    written += result.bytesWritten
  }
}
