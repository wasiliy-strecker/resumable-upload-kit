import type { UploadCheckpoint, UploadCheckpointStore } from './types.js'

export class MemoryUploadCheckpointStore implements UploadCheckpointStore {
  readonly #checkpoints = new Map<string, UploadCheckpoint>()

  public delete(id: string): Promise<void> {
    this.#checkpoints.delete(id)
    return Promise.resolve()
  }

  public get(id: string): Promise<UploadCheckpoint | null> {
    const checkpoint = this.#checkpoints.get(id)
    return Promise.resolve(checkpoint ? cloneCheckpoint(checkpoint) : null)
  }

  public list(): Promise<readonly UploadCheckpoint[]> {
    return Promise.resolve(
      [...this.#checkpoints.values()]
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .map(cloneCheckpoint),
    )
  }

  public put(checkpoint: UploadCheckpoint): Promise<void> {
    this.#checkpoints.set(checkpoint.id, cloneCheckpoint(checkpoint))
    return Promise.resolve()
  }
}

export function cloneCheckpoint(checkpoint: UploadCheckpoint): UploadCheckpoint {
  return Object.freeze({
    ...checkpoint,
    metadata: Object.freeze(
      checkpoint.metadata.map(({ key, value }) =>
        Object.freeze({ key, value: new Uint8Array(value) }),
      ),
    ),
  })
}
