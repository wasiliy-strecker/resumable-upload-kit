import { serializeUploadMetadata } from '@resumable-upload-kit/protocol'

import { UploadClientError, asUploadClientError } from './errors.js'
import { cloneCheckpoint } from './memory-store.js'
import { digestSha256 } from './source.js'
import { FetchTusTransport } from './transport.js'
import type {
  CreateResumableUploadClientOptions,
  CreateUploadTaskInput,
  RemoteUploadState,
  ResumableUploadClient,
  RetryPolicy,
  SleepFunction,
  TusTransport,
  UploadCheckpoint,
  UploadCheckpointPhase,
  UploadCheckpointStore,
  UploadSource,
  UploadTask,
  UploadTaskListener,
  UploadTaskState,
  UploadTaskStatus,
} from './types.js'

const defaultChunkSize = 5 * 1_024 * 1_024
const defaultRetryPolicy: RetryPolicy = Object.freeze({
  baseDelayMs: 500,
  jitterRatio: 0.2,
  maximumAttempts: 5,
  maximumDelayMs: 8_000,
})

interface ResolvedClientOptions {
  readonly checkpointStore: UploadCheckpointStore
  readonly chunkSize: number
  readonly clock: () => Date
  readonly createId: () => string
  readonly onTerminal: (id: string) => void
  readonly random: () => number
  readonly retry: RetryPolicy
  readonly sleep: SleepFunction
  readonly transport: TusTransport
}

export function createResumableUploadClient(
  options: CreateResumableUploadClientOptions,
): ResumableUploadClient {
  const chunkSize = positiveSafeInteger(options.chunkSize ?? defaultChunkSize, 'chunkSize')
  const retry = resolveRetryPolicy(options.retry)
  const clock = options.clock ?? (() => new Date())
  const createId = options.createId ?? defaultCreateId
  const random = options.random ?? Math.random
  const sleep = options.sleep ?? abortableSleep
  const transport =
    options.transport ??
    new FetchTusTransport({
      clock,
      endpoint: options.endpoint,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.resolveHeaders ? { resolveHeaders: options.resolveHeaders } : {}),
    })
  const tasks = new Map<string, UploadTaskController>()
  const resolved: ResolvedClientOptions = {
    checkpointStore: options.checkpointStore,
    chunkSize,
    clock,
    createId,
    onTerminal: (id) => tasks.delete(id),
    random,
    retry,
    sleep,
    transport,
  }

  return {
    async create(input: CreateUploadTaskInput): Promise<UploadTask> {
      assertSource(input.source)
      const metadata = cloneMetadata(input.metadata ?? [])
      serializeUploadMetadata(metadata)
      const timestamp = validTimestamp(clock())
      const id = createId()

      if (id.trim().length === 0 || id.length > 200) {
        throw new Error(
          'Generated checkpoint identifiers must contain between 1 and 200 characters',
        )
      }

      const checkpoint: UploadCheckpoint = Object.freeze({
        confirmedOffset: 0,
        createdAt: timestamp,
        expiresAt: null,
        id,
        lastErrorCode: null,
        metadata,
        phase: 'creating',
        size: input.source.size,
        sourceFingerprint: input.source.fingerprint,
        updatedAt: timestamp,
        uploadUrl: null,
      })
      await options.checkpointStore.put(checkpoint)
      const task = new UploadTaskController(checkpoint, input.source, resolved)
      tasks.set(id, task)
      return task
    },

    async list(): Promise<readonly UploadCheckpoint[]> {
      return options.checkpointStore.list()
    },

    async resume(checkpointId: string, source: UploadSource): Promise<UploadTask> {
      assertSource(source)
      const running = tasks.get(checkpointId)

      if (running) {
        running.assertSource(source)
        return running
      }

      const checkpoint = await requireCheckpoint(options.checkpointStore, checkpointId)
      assertCheckpoint(checkpoint)
      assertMatchingSource(checkpoint, source)
      const task = new UploadTaskController(checkpoint, source, resolved)
      tasks.set(checkpointId, task)
      return task
    },

    async terminate(checkpointId: string): Promise<void> {
      const running = tasks.get(checkpointId)

      if (running) {
        await running.cancel()
        return
      }

      const checkpoint = await requireCheckpoint(options.checkpointStore, checkpointId)

      if (checkpoint.uploadUrl) {
        try {
          await transport.terminate(checkpoint.uploadUrl, new AbortController().signal)
        } catch (error) {
          const clientError = asUploadClientError(error)

          if (clientError.code !== 'remote_not_found' && clientError.code !== 'upload_expired') {
            throw clientError
          }
        }
      }

      await options.checkpointStore.delete(checkpointId)
    },
  }
}

class UploadTaskController implements UploadTask {
  readonly #listeners = new Set<UploadTaskListener>()
  readonly #options: ResolvedClientOptions
  readonly #source: UploadSource
  #abortController: AbortController | null = null
  #cancelRequested = false
  #checkpoint: UploadCheckpoint
  #pauseRequested = false
  #runPromise: Promise<UploadTaskState> | null = null
  #state: UploadTaskState

  public constructor(
    checkpoint: UploadCheckpoint,
    source: UploadSource,
    options: ResolvedClientOptions,
  ) {
    this.#checkpoint = cloneCheckpoint(checkpoint)
    this.#source = source
    this.#options = options
    this.#state = createState(checkpoint, checkpoint.phase === 'failed' ? 'failed' : 'paused')
  }

  public get id(): string {
    return this.#checkpoint.id
  }

  public get state(): UploadTaskState {
    return this.#state
  }

  public assertSource(source: UploadSource): void {
    assertMatchingSource(this.#checkpoint, source)
  }

  public start(): Promise<UploadTaskState> {
    if (this.#runPromise) {
      return this.#runPromise
    }

    if (this.#state.status === 'completed' || this.#state.status === 'canceled') {
      return Promise.resolve(this.#state)
    }

    if (this.#checkpoint.uploadUrl === null && this.#checkpoint.phase === 'failed') {
      return Promise.reject(
        this.#state.error ??
          new UploadClientError({
            code: 'protocol_error',
            message: 'A failed creation cannot be retried safely without a remote upload URL',
          }),
      )
    }

    this.#pauseRequested = false
    this.#cancelRequested = false
    this.#abortController = new AbortController()
    this.#runPromise = this.#run(this.#abortController.signal).finally(() => {
      this.#abortController = null
      this.#runPromise = null
    })
    return this.#runPromise
  }

  public pause(): void {
    if (isTerminal(this.#state.status)) {
      return
    }

    this.#pauseRequested = true
    this.#transition('paused', { attempt: 0, error: null })
    this.#abortController?.abort(new DOMException('Upload paused', 'AbortError'))
  }

  public async cancel(): Promise<void> {
    if (this.#state.status === 'completed' || this.#state.status === 'canceled') {
      return
    }

    this.#cancelRequested = true
    this.#pauseRequested = false
    this.#abortController?.abort(new DOMException('Upload canceled', 'AbortError'))
    await this.#runPromise?.catch(() => undefined)

    if (
      this.#checkpoint.uploadUrl === null &&
      this.#checkpoint.lastErrorCode === 'creation_ambiguous'
    ) {
      this.#cancelRequested = false
      throw (
        this.#state.error ??
        new UploadClientError({
          code: 'creation_ambiguous',
          message: 'The remote result of upload creation is unknown',
        })
      )
    }

    try {
      if (this.#checkpoint.uploadUrl) {
        await this.#options.transport.terminate(
          this.#checkpoint.uploadUrl,
          new AbortController().signal,
        )
      }
    } catch (error) {
      const clientError = asUploadClientError(error)

      if (clientError.code !== 'remote_not_found' && clientError.code !== 'upload_expired') {
        this.#cancelRequested = false
        await this.#fail(clientError)
        throw clientError
      }
    }

    await this.#options.checkpointStore.delete(this.id)
    this.#transition('canceled', { attempt: 0, error: null })
    this.#options.onTerminal(this.id)
  }

  public subscribe(listener: UploadTaskListener): () => void {
    this.#listeners.add(listener)

    try {
      listener(this.#state)
    } catch {
      // Observers cannot change upload correctness.
    }

    return () => this.#listeners.delete(listener)
  }

  async #run(signal: AbortSignal): Promise<UploadTaskState> {
    try {
      if (this.#checkpoint.uploadUrl === null) {
        this.#transition('creating', { attempt: 1, error: null })
        const remote = await this.#options.transport.create({
          metadata: this.#checkpoint.metadata,
          signal,
          size: this.#checkpoint.size,
        })
        this.#validateRemote(remote)
        await this.#applyRemote(remote, 'active')
      } else {
        await this.#reconcile(signal)
      }

      while (this.#checkpoint.confirmedOffset < this.#checkpoint.size) {
        await this.#appendNextChunk(signal)
      }

      await this.#options.checkpointStore.delete(this.id)
      this.#transition('completed', { attempt: 0, error: null })
      this.#options.onTerminal(this.id)
      return this.#state
    } catch (error) {
      if (signal.aborted && (this.#pauseRequested || this.#cancelRequested)) {
        if (this.#checkpoint.uploadUrl === null && this.#checkpoint.phase === 'creating') {
          await this.#fail(
            new UploadClientError({
              cause: error,
              code: 'creation_ambiguous',
              message:
                'Upload creation was interrupted before the remote Location could be confirmed',
            }),
          )
          return this.#state
        }

        if (this.#pauseRequested) {
          await this.#save({ lastErrorCode: null, phase: 'paused' })
          this.#transition('paused', { attempt: 0, error: null })
        }

        return this.#state
      }

      const clientError = asUploadClientError(error)
      await this.#fail(clientError)
      throw clientError
    }
  }

  async #appendNextChunk(signal: AbortSignal): Promise<void> {
    const start = this.#checkpoint.confirmedOffset
    const end = Math.min(start + this.#options.chunkSize, this.#checkpoint.size)
    const body = this.#source.slice(start, end)
    assertNotAborted(signal)
    const checksum = await digestSha256(body)
    assertNotAborted(signal)
    let failure: UploadClientError | null = null

    for (let attempt = 1; attempt <= this.#options.retry.maximumAttempts; attempt += 1) {
      this.#transition('uploading', { attempt, error: null })

      try {
        const remote = await this.#options.transport.append({
          body,
          checksum,
          length: this.#checkpoint.size,
          offset: start,
          signal,
          uploadUrl: requireUploadUrl(this.#checkpoint),
        })
        this.#validateRemote(remote)

        if (remote.offset !== end) {
          throw new UploadClientError({
            code: 'invalid_response',
            message: `PATCH confirmed offset ${remote.offset}, expected ${end}`,
          })
        }

        await this.#applyRemote(remote, 'active')
        return
      } catch (error) {
        if (signal.aborted) {
          throw error
        }

        failure = asUploadClientError(error)

        if (!failure.retryable) {
          throw failure
        }

        await this.#recoverAfterAppendFailure(failure, attempt, signal)

        if (this.#checkpoint.confirmedOffset !== start) {
          return
        }

        if (attempt < this.#options.retry.maximumAttempts) {
          await this.#waitForRetry(failure, attempt, signal)
        }
      }
    }

    throw retryExhausted(failure)
  }

  async #recoverAfterAppendFailure(
    initialFailure: UploadClientError,
    attempt: number,
    signal: AbortSignal,
  ): Promise<void> {
    this.#transition('retrying', { attempt, error: initialFailure })
    let failure = initialFailure

    for (
      let headAttempt = 1;
      headAttempt <= this.#options.retry.maximumAttempts;
      headAttempt += 1
    ) {
      try {
        const remote = await this.#options.transport.head(
          requireUploadUrl(this.#checkpoint),
          signal,
        )
        this.#validateRemote(remote)
        await this.#applyRemote(remote, 'active')
        return
      } catch (error) {
        if (signal.aborted) {
          throw error
        }

        failure = asUploadClientError(error)

        if (!failure.retryable || headAttempt === this.#options.retry.maximumAttempts) {
          throw failure.retryable ? retryExhausted(failure) : failure
        }

        this.#transition('retrying', { attempt: headAttempt, error: failure })
        await this.#waitForRetry(failure, headAttempt, signal)
      }
    }
  }

  async #reconcile(signal: AbortSignal): Promise<void> {
    this.#transition('reconciling', { attempt: 1, error: null })
    let failure: UploadClientError | null = null

    for (let attempt = 1; attempt <= this.#options.retry.maximumAttempts; attempt += 1) {
      if (failure) {
        this.#transition('retrying', { attempt, error: failure })
        await this.#waitForRetry(failure, attempt - 1, signal)
      }

      try {
        const remote = await this.#options.transport.head(
          requireUploadUrl(this.#checkpoint),
          signal,
        )
        this.#validateRemote(remote)
        await this.#applyRemote(remote, 'active')
        return
      } catch (error) {
        if (signal.aborted) {
          throw error
        }

        failure = asUploadClientError(error)

        if (!failure.retryable) {
          throw failure
        }
      }
    }

    throw retryExhausted(failure)
  }

  async #waitForRetry(
    failure: UploadClientError,
    attempt: number,
    signal: AbortSignal,
  ): Promise<void> {
    const delay =
      failure.retryAfterMs ?? jitteredBackoff(attempt, this.#options.retry, this.#options.random())
    await this.#options.sleep(delay, signal)
  }

  #validateRemote(remote: RemoteUploadState): void {
    if (remote.length !== this.#checkpoint.size) {
      throw new UploadClientError({
        code: 'source_mismatch',
        message: `Remote upload length ${remote.length} does not match source size ${this.#checkpoint.size}`,
      })
    }

    if (
      !Number.isSafeInteger(remote.offset) ||
      remote.offset < this.#checkpoint.confirmedOffset ||
      remote.offset > remote.length
    ) {
      throw new UploadClientError({
        code: 'invalid_response',
        message: 'The remote upload returned an invalid or backwards offset',
      })
    }
  }

  async #applyRemote(remote: RemoteUploadState, phase: UploadCheckpointPhase): Promise<void> {
    await this.#save({
      confirmedOffset: remote.offset,
      expiresAt: remote.expiresAt,
      lastErrorCode: null,
      phase,
      uploadUrl: remote.uploadUrl,
    })
    this.#state = Object.freeze({
      ...this.#state,
      confirmedOffset: remote.offset,
      uploadUrl: remote.uploadUrl,
    })
    this.#publish()
  }

  async #fail(error: UploadClientError): Promise<void> {
    await this.#save({ lastErrorCode: error.code, phase: 'failed' })
    this.#transition('failed', { attempt: this.#state.attempt, error })
  }

  async #save(changes: Partial<UploadCheckpoint>): Promise<void> {
    this.#checkpoint = cloneCheckpoint({
      ...this.#checkpoint,
      ...changes,
      updatedAt: validTimestamp(this.#options.clock()),
    })
    await this.#options.checkpointStore.put(this.#checkpoint)
  }

  #transition(status: UploadTaskStatus, changes: Pick<UploadTaskState, 'attempt' | 'error'>): void {
    this.#state = Object.freeze({ ...this.#state, ...changes, status })
    this.#publish()
  }

  #publish(): void {
    for (const listener of this.#listeners) {
      try {
        listener(this.#state)
      } catch {
        // Observers cannot change upload correctness.
      }
    }
  }
}

function createState(checkpoint: UploadCheckpoint, status: UploadTaskStatus): UploadTaskState {
  return Object.freeze({
    attempt: 0,
    confirmedOffset: checkpoint.confirmedOffset,
    error: null,
    id: checkpoint.id,
    status,
    totalBytes: checkpoint.size,
    uploadUrl: checkpoint.uploadUrl,
  })
}

function resolveRetryPolicy(input: Partial<RetryPolicy> | undefined): RetryPolicy {
  const retry = Object.freeze({ ...defaultRetryPolicy, ...input })
  positiveSafeInteger(retry.baseDelayMs, 'retry.baseDelayMs')
  positiveSafeInteger(retry.maximumAttempts, 'retry.maximumAttempts')
  positiveSafeInteger(retry.maximumDelayMs, 'retry.maximumDelayMs')

  if (retry.maximumDelayMs < retry.baseDelayMs) {
    throw new Error('retry.maximumDelayMs must not be smaller than retry.baseDelayMs')
  }

  if (!Number.isFinite(retry.jitterRatio) || retry.jitterRatio < 0 || retry.jitterRatio > 1) {
    throw new Error('retry.jitterRatio must be between 0 and 1')
  }

  return retry
}

function jitteredBackoff(attempt: number, retry: RetryPolicy, random: number): number {
  if (!Number.isFinite(random) || random < 0 || random > 1) {
    throw new Error('random must return a number between 0 and 1')
  }

  const exponential = Math.min(retry.maximumDelayMs, retry.baseDelayMs * 2 ** (attempt - 1))
  const jitter = 1 + (random * 2 - 1) * retry.jitterRatio
  return Math.max(0, Math.round(exponential * jitter))
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`)
  }

  return value
}

function assertSource(source: UploadSource): void {
  if (
    !Number.isSafeInteger(source.size) ||
    source.size < 0 ||
    source.fingerprint.trim().length === 0 ||
    source.fingerprint.length > 1_024 ||
    typeof source.slice !== 'function'
  ) {
    throw new TypeError('Upload source is invalid')
  }
}

function assertMatchingSource(checkpoint: UploadCheckpoint, source: UploadSource): void {
  if (checkpoint.size !== source.size || checkpoint.sourceFingerprint !== source.fingerprint) {
    throw new UploadClientError({
      code: 'source_mismatch',
      message: 'The selected source does not match the persisted upload checkpoint',
    })
  }
}

function assertCheckpoint(checkpoint: UploadCheckpoint): void {
  if (
    !Number.isSafeInteger(checkpoint.size) ||
    !Number.isSafeInteger(checkpoint.confirmedOffset) ||
    checkpoint.size < 0 ||
    checkpoint.confirmedOffset < 0 ||
    checkpoint.confirmedOffset > checkpoint.size ||
    checkpoint.sourceFingerprint.length === 0
  ) {
    throw new UploadClientError({
      code: 'invalid_checkpoint',
      message: 'The persisted upload checkpoint is invalid',
    })
  }
}

async function requireCheckpoint(
  store: UploadCheckpointStore,
  checkpointId: string,
): Promise<UploadCheckpoint> {
  const checkpoint = await store.get(checkpointId)

  if (!checkpoint) {
    throw new UploadClientError({
      code: 'checkpoint_not_found',
      message: `Upload checkpoint ${checkpointId} does not exist`,
    })
  }

  return checkpoint
}

function cloneMetadata(metadata: readonly { readonly key: string; readonly value: Uint8Array }[]) {
  return Object.freeze(
    metadata.map(({ key, value }) => Object.freeze({ key, value: new Uint8Array(value) })),
  )
}

function requireUploadUrl(checkpoint: UploadCheckpoint): string {
  if (!checkpoint.uploadUrl) {
    throw new UploadClientError({
      code: 'invalid_checkpoint',
      message: 'Upload checkpoint does not contain a remote URL',
    })
  }

  return checkpoint.uploadUrl
}

function validTimestamp(date: Date): string {
  if (!Number.isFinite(date.getTime())) {
    throw new Error('clock must return a valid Date')
  }

  return date.toISOString()
}

function defaultCreateId(): string {
  if (!globalThis.crypto?.randomUUID) {
    throw new Error('Crypto.randomUUID is required to create upload checkpoints')
  }

  return globalThis.crypto.randomUUID()
}

function retryExhausted(cause: UploadClientError | null): UploadClientError {
  return new UploadClientError({
    ...(cause ? { cause } : {}),
    code: 'retry_exhausted',
    message: 'The upload retry budget was exhausted',
  })
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw abortReason(signal)
  }
}

function isTerminal(status: UploadTaskStatus): boolean {
  return status === 'completed' || status === 'canceled'
}

function abortableSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal))
      return
    }

    const onAbort = () => {
      clearTimeout(timeout)
      reject(abortReason(signal))
    }
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted', 'AbortError')
}
