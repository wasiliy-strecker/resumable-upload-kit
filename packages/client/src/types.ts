import type { UploadMetadataEntry } from '@resumable-upload-kit/protocol'

import type { UploadClientError } from './errors.js'

export type UploadTaskStatus =
  | 'creating'
  | 'reconciling'
  | 'uploading'
  | 'retrying'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'canceled'

export type UploadCheckpointPhase = 'creating' | 'active' | 'paused' | 'failed'

export interface UploadSource {
  readonly fingerprint: string
  readonly size: number
  slice(start: number, end: number): Blob
}

export interface UploadCheckpoint {
  readonly confirmedOffset: number
  readonly createdAt: string
  readonly expiresAt: string | null
  readonly id: string
  readonly lastErrorCode: string | null
  readonly metadata: readonly UploadMetadataEntry[]
  readonly phase: UploadCheckpointPhase
  readonly sourceFingerprint: string
  readonly size: number
  readonly updatedAt: string
  readonly uploadUrl: string | null
}

export interface UploadCheckpointStore {
  delete(id: string): Promise<void>
  get(id: string): Promise<UploadCheckpoint | null>
  list(): Promise<readonly UploadCheckpoint[]>
  put(checkpoint: UploadCheckpoint): Promise<void>
}

export interface UploadTaskState {
  readonly attempt: number
  readonly confirmedOffset: number
  readonly error: UploadClientError | null
  readonly id: string
  readonly status: UploadTaskStatus
  readonly totalBytes: number
  readonly uploadUrl: string | null
}

export type UploadTaskListener = (state: UploadTaskState) => void

export interface UploadTask {
  readonly id: string
  readonly state: UploadTaskState
  cancel(): Promise<void>
  pause(): void
  start(): Promise<UploadTaskState>
  subscribe(listener: UploadTaskListener): () => void
}

export interface CreateUploadTaskInput {
  readonly metadata?: readonly UploadMetadataEntry[]
  readonly source: UploadSource
}

export interface ResumableUploadClient {
  create(input: CreateUploadTaskInput): Promise<UploadTask>
  list(): Promise<readonly UploadCheckpoint[]>
  resume(checkpointId: string, source: UploadSource): Promise<UploadTask>
  terminate(checkpointId: string): Promise<void>
}

export interface RetryPolicy {
  readonly baseDelayMs: number
  readonly maximumAttempts: number
  readonly maximumDelayMs: number
  readonly jitterRatio: number
}

export interface CreateResumableUploadClientOptions {
  readonly checkpointStore: UploadCheckpointStore
  readonly chunkSize?: number
  readonly clock?: () => Date
  readonly createId?: () => string
  readonly endpoint: string
  readonly fetch?: FetchLike
  readonly random?: () => number
  readonly resolveHeaders?: () => HeadersInit | Promise<HeadersInit>
  readonly retry?: Partial<RetryPolicy>
  readonly sleep?: SleepFunction
  readonly transport?: TusTransport
}

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
export type SleepFunction = (delayMs: number, signal: AbortSignal) => Promise<void>

export interface CreateRemoteUploadInput {
  readonly metadata: readonly UploadMetadataEntry[]
  readonly signal: AbortSignal
  readonly size: number
}

export interface RemoteUploadState {
  readonly expiresAt: string | null
  readonly length: number
  readonly offset: number
  readonly uploadUrl: string
}

export interface AppendRemoteChunkInput {
  readonly body: Blob
  readonly checksum: Uint8Array
  readonly length: number
  readonly offset: number
  readonly signal: AbortSignal
  readonly uploadUrl: string
}

export interface TusTransport {
  append(input: AppendRemoteChunkInput): Promise<RemoteUploadState>
  create(input: CreateRemoteUploadInput): Promise<RemoteUploadState>
  head(uploadUrl: string, signal: AbortSignal): Promise<RemoteUploadState>
  terminate(uploadUrl: string, signal: AbortSignal): Promise<void>
}
