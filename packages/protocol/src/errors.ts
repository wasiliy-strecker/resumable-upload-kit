export type TusErrorCode =
  | 'checksum_mismatch'
  | 'invalid_header'
  | 'invalid_metadata'
  | 'offset_mismatch'
  | 'unauthorized'
  | 'unsupported_checksum_algorithm'
  | 'unsupported_media_type'
  | 'unsupported_version'
  | 'upload_expired'
  | 'upload_locked'
  | 'upload_not_found'
  | 'upload_too_large'

export interface TusProtocolErrorOptions {
  readonly cause?: unknown
  readonly code: TusErrorCode
  readonly headers?: Readonly<Record<string, string>>
  readonly message: string
  readonly status: number
}

export class TusProtocolError extends Error {
  public override readonly name = 'TusProtocolError'
  public readonly code: TusErrorCode
  public readonly headers: Readonly<Record<string, string>>
  public readonly status: number

  public constructor(options: TusProtocolErrorOptions) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause })
    this.code = options.code
    this.headers = Object.freeze({ ...options.headers })
    this.status = options.status
  }
}
