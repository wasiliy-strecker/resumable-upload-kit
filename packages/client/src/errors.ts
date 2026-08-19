export type UploadClientErrorCode =
  | 'authentication_failed'
  | 'checkpoint_not_found'
  | 'creation_ambiguous'
  | 'invalid_checkpoint'
  | 'invalid_response'
  | 'network_error'
  | 'protocol_error'
  | 'remote_not_found'
  | 'retry_exhausted'
  | 'source_mismatch'
  | 'upload_expired'

export interface UploadClientErrorOptions {
  readonly cause?: unknown
  readonly code: UploadClientErrorCode
  readonly message: string
  readonly retryAfterMs?: number
  readonly retryable?: boolean
  readonly status?: number
}

export class UploadClientError extends Error {
  public override readonly name = 'UploadClientError'
  public readonly code: UploadClientErrorCode
  public readonly retryAfterMs: number | null
  public readonly retryable: boolean
  public readonly status: number | null

  public constructor(options: UploadClientErrorOptions) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause })
    this.code = options.code
    this.retryAfterMs = options.retryAfterMs ?? null
    this.retryable = options.retryable ?? false
    this.status = options.status ?? null
  }
}

export function asUploadClientError(error: unknown): UploadClientError {
  if (error instanceof UploadClientError) {
    return error
  }

  return new UploadClientError({
    cause: error,
    code: 'protocol_error',
    message: error instanceof Error ? error.message : 'The upload failed unexpectedly',
  })
}
