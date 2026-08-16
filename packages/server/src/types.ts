import type {
  TusChecksumAlgorithm,
  UploadChecksum,
  UploadMetadataEntry,
} from '@resumable-upload-kit/protocol'

export type UploadStatus = 'active' | 'completed' | 'expired' | 'terminated'
export type GoneReason = 'expired' | 'terminated'

export interface UploadRecord {
  readonly createdAt: Date
  readonly expiresAt: Date | null
  readonly id: string
  readonly leaseExpiresAt: Date | null
  readonly leaseId: string | null
  readonly length: number
  readonly metadata: readonly UploadMetadataEntry[]
  readonly offset: number
  readonly ownerId: string
  readonly status: UploadStatus
  readonly updatedAt: Date
}

export interface CreateUploadRecordInput {
  readonly expiresAt: Date | null
  readonly id: string
  readonly length: number
  readonly metadata: readonly UploadMetadataEntry[]
  readonly now: Date
  readonly ownerId: string
}

export type UploadLookupResult =
  | { readonly kind: 'found'; readonly upload: UploadRecord }
  | { readonly kind: 'gone'; readonly reason: GoneReason }
  | { readonly kind: 'missing' }

export interface AcquireUploadLeaseInput {
  readonly expectedOffset: number
  readonly leaseExpiresAt: Date
  readonly leaseId: string
  readonly now: Date
  readonly ownerId: string
  readonly uploadId: string
}

export type AcquireUploadLeaseResult =
  | { readonly kind: 'acquired'; readonly upload: UploadRecord }
  | { readonly currentOffset: number; readonly kind: 'conflict' }
  | { readonly kind: 'gone'; readonly reason: GoneReason }
  | { readonly kind: 'locked'; readonly retryAt: Date }
  | { readonly kind: 'missing' }

export interface CommitUploadLeaseInput {
  readonly leaseId: string
  readonly newOffset: number
  readonly now: Date
  readonly ownerId: string
  readonly uploadId: string
}

export type CommitUploadLeaseResult =
  { readonly applied: false } | { readonly applied: true; readonly upload: UploadRecord }

export interface ReleaseUploadLeaseInput {
  readonly leaseId: string
  readonly now: Date
  readonly ownerId: string
  readonly uploadId: string
}

export interface TerminateUploadInput {
  readonly now: Date
  readonly ownerId: string
  readonly uploadId: string
}

export type TerminateUploadResult =
  | { readonly kind: 'gone'; readonly reason: GoneReason }
  | { readonly kind: 'locked'; readonly retryAt: Date }
  | { readonly kind: 'missing' }
  | { readonly kind: 'terminated'; readonly upload: UploadRecord }

export interface UploadRepository {
  acquireLease(input: AcquireUploadLeaseInput): Promise<AcquireUploadLeaseResult>
  commitLease(input: CommitUploadLeaseInput): Promise<CommitUploadLeaseResult>
  create(input: CreateUploadRecordInput): Promise<UploadRecord>
  findOwned(uploadId: string, ownerId: string, now: Date): Promise<UploadLookupResult>
  releaseLease(input: ReleaseUploadLeaseInput): Promise<void>
  terminate(input: TerminateUploadInput): Promise<TerminateUploadResult>
}

export interface StageUploadChunkInput {
  readonly checksumAlgorithm?: TusChecksumAlgorithm
  readonly expectedLength: number
  readonly source: AsyncIterable<Uint8Array>
  readonly uploadId: string
}

export interface StagedUploadChunk {
  readonly digest: Uint8Array | null
  readonly length: number
  readonly token: string
}

export interface UploadBlobStore {
  append(uploadId: string, offset: number, chunk: StagedUploadChunk): Promise<void>
  create(uploadId: string): Promise<void>
  delete(uploadId: string): Promise<void>
  discard(chunk: StagedUploadChunk): Promise<void>
  reconcile(uploadId: string, confirmedOffset: number): Promise<void>
  stage(input: StageUploadChunkInput): Promise<StagedUploadChunk>
}

export type UploadBlobErrorReason = 'corrupt' | 'length-mismatch'

export class UploadBlobError extends Error {
  public override readonly name = 'UploadBlobError'

  public constructor(
    public readonly reason: UploadBlobErrorReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

export interface UploadLimits {
  readonly expirationMs: number
  readonly leaseDurationMs: number
  readonly maximumChunkBytes: number
  readonly maximumUploadBytes: number
}

export interface CreateUploadInput {
  readonly length: number
  readonly metadata: readonly UploadMetadataEntry[]
  readonly ownerId: string
}

export interface AppendUploadInput {
  readonly checksum?: UploadChecksum
  readonly contentLength: number
  readonly offset: number
  readonly ownerId: string
  readonly source: AsyncIterable<Uint8Array>
  readonly uploadId: string
}

export interface UploadService {
  readonly limits: UploadLimits
  append(input: AppendUploadInput): Promise<UploadRecord>
  create(input: CreateUploadInput): Promise<UploadRecord>
  head(uploadId: string, ownerId: string): Promise<UploadRecord>
  terminate(uploadId: string, ownerId: string): Promise<void>
}

export interface CreateUploadServiceOptions {
  readonly blobStore: UploadBlobStore
  readonly clock?: () => Date
  readonly createId?: () => string
  readonly limits?: Partial<UploadLimits>
  readonly repository: UploadRepository
}
