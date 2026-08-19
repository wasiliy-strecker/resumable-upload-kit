import {
  parseTusResumable,
  parseUploadLength,
  parseUploadOffset,
  serializeUploadChecksum,
  serializeUploadMetadata,
  tusHeader,
  tusOffsetContentType,
  tusVersion,
} from '@resumable-upload-kit/protocol'

import { UploadClientError } from './errors.js'
import type {
  AppendRemoteChunkInput,
  CreateRemoteUploadInput,
  FetchLike,
  RemoteUploadState,
  TusTransport,
} from './types.js'

export interface FetchTusTransportOptions {
  readonly clock?: () => Date
  readonly endpoint: string
  readonly fetch?: FetchLike
  readonly resolveHeaders?: () => HeadersInit | Promise<HeadersInit>
}

export class FetchTusTransport implements TusTransport {
  readonly #clock: () => Date
  readonly #endpoint: string
  readonly #fetch: FetchLike
  readonly #resolveHeaders: () => HeadersInit | Promise<HeadersInit>

  public constructor(options: FetchTusTransportOptions) {
    if (options.endpoint.trim().length === 0) {
      throw new Error('Upload endpoint must not be empty')
    }

    const fetchImplementation = options.fetch ?? globalThis.fetch?.bind(globalThis)

    if (!fetchImplementation) {
      throw new Error('Fetch is not available in this runtime')
    }

    this.#clock = options.clock ?? (() => new Date())
    this.#endpoint = options.endpoint
    this.#fetch = fetchImplementation
    this.#resolveHeaders = options.resolveHeaders ?? (() => ({}))
  }

  public async create(input: CreateRemoteUploadInput): Promise<RemoteUploadState> {
    const headers = await this.#headers()
    headers.set(tusHeader.resumable, tusVersion)
    headers.set(tusHeader.uploadLength, String(input.size))

    if (input.metadata.length > 0) {
      headers.set(tusHeader.uploadMetadata, serializeUploadMetadata(input.metadata))
    }

    const response = await this.#request(this.#endpoint, {
      headers,
      method: 'POST',
      signal: input.signal,
    })
    requireSuccess(response, this.#clock())
    const location = response.headers.get('Location')

    if (!location) {
      throw invalidResponse('Creation response is missing Location')
    }

    return Object.freeze({
      expiresAt: parseExpiration(response.headers.get(tusHeader.uploadExpires)),
      length: input.size,
      offset: 0,
      uploadUrl: resolveLocation(location, response.url, this.#endpoint),
    })
  }

  public async head(uploadUrl: string, signal: AbortSignal): Promise<RemoteUploadState> {
    const headers = await this.#headers()
    headers.set(tusHeader.resumable, tusVersion)
    const response = await this.#request(uploadUrl, { headers, method: 'HEAD', signal })
    requireSuccess(response, this.#clock())
    const length = parseResponseInteger(
      () => parseUploadLength(response.headers.get(tusHeader.uploadLength)),
      'HEAD response contains an invalid Upload-Length',
    )
    const offset = parseResponseInteger(
      () => parseUploadOffset(response.headers.get(tusHeader.uploadOffset)),
      'HEAD response contains an invalid Upload-Offset',
    )

    if (offset > length) {
      throw invalidResponse('HEAD response offset exceeds the upload length')
    }

    return Object.freeze({
      expiresAt: parseExpiration(response.headers.get(tusHeader.uploadExpires)),
      length,
      offset,
      uploadUrl,
    })
  }

  public async append(input: AppendRemoteChunkInput): Promise<RemoteUploadState> {
    const headers = await this.#headers()
    headers.set('Content-Type', tusOffsetContentType)
    headers.set(tusHeader.resumable, tusVersion)
    headers.set(
      tusHeader.uploadChecksum,
      serializeUploadChecksum({ algorithm: 'sha256', digest: input.checksum }),
    )
    headers.set(tusHeader.uploadOffset, String(input.offset))
    const response = await this.#request(input.uploadUrl, {
      body: input.body,
      headers,
      method: 'PATCH',
      signal: input.signal,
    })
    requireSuccess(response, this.#clock())
    const offset = parseResponseInteger(
      () => parseUploadOffset(response.headers.get(tusHeader.uploadOffset)),
      'PATCH response contains an invalid Upload-Offset',
    )

    if (offset > input.length) {
      throw invalidResponse('PATCH response offset exceeds the upload length')
    }

    return Object.freeze({
      expiresAt: parseExpiration(response.headers.get(tusHeader.uploadExpires)),
      length: input.length,
      offset,
      uploadUrl: input.uploadUrl,
    })
  }

  public async terminate(uploadUrl: string, signal: AbortSignal): Promise<void> {
    const headers = await this.#headers()
    headers.set(tusHeader.resumable, tusVersion)
    const response = await this.#request(uploadUrl, { headers, method: 'DELETE', signal })
    requireSuccess(response, this.#clock())
  }

  async #headers(): Promise<Headers> {
    const headers = new Headers(await this.#resolveHeaders())

    for (const name of [
      'Content-Length',
      'Content-Type',
      tusHeader.resumable,
      tusHeader.uploadChecksum,
      tusHeader.uploadLength,
      tusHeader.uploadMetadata,
      tusHeader.uploadOffset,
    ]) {
      headers.delete(name)
    }

    return headers
  }

  async #request(input: RequestInfo | URL, init: RequestInit): Promise<Response> {
    try {
      return await this.#fetch(input, init)
    } catch (error) {
      if (init.signal?.aborted) {
        throw error
      }

      throw new UploadClientError({
        cause: error,
        code: 'network_error',
        message: 'The upload request did not receive a response',
        retryable: true,
      })
    }
  }
}

function requireSuccess(response: Response, now: Date): void {
  if (!response.ok) {
    throw responseError(response, now)
  }

  try {
    parseTusResumable(response.headers.get(tusHeader.resumable))
  } catch (error) {
    throw new UploadClientError({
      cause: error,
      code: 'invalid_response',
      message: 'Successful response is missing a valid Tus-Resumable header',
      status: response.status,
    })
  }
}

function responseError(response: Response, now: Date): UploadClientError {
  const retryAfterMs = parseRetryAfter(response.headers.get('Retry-After'), now)
  const common = { status: response.status }

  switch (response.status) {
    case 401:
    case 403:
      return new UploadClientError({
        ...common,
        code: 'authentication_failed',
        message: 'The upload request was not authorized',
      })
    case 404:
      return new UploadClientError({
        ...common,
        code: 'remote_not_found',
        message: 'The remote upload no longer exists',
      })
    case 410:
      return new UploadClientError({
        ...common,
        code: 'upload_expired',
        message: 'The remote upload has expired or was terminated',
      })
    case 408:
    case 409:
    case 423:
    case 425:
    case 429:
    case 460:
      return new UploadClientError({
        ...common,
        ...(retryAfterMs === null ? {} : { retryAfterMs }),
        code: 'protocol_error',
        message: `The upload server rejected the request with ${response.status}`,
        retryable: true,
      })
    default:
      return new UploadClientError({
        ...common,
        code: response.status >= 500 ? 'network_error' : 'protocol_error',
        message: `The upload server returned ${response.status}`,
        retryable: response.status >= 500,
      })
  }
}

function parseResponseInteger(parser: () => number, message: string): number {
  try {
    return parser()
  } catch (error) {
    throw new UploadClientError({ cause: error, code: 'invalid_response', message })
  }
}

function parseExpiration(value: string | null): string | null {
  if (value === null) {
    return null
  }

  const date = new Date(value)

  if (!Number.isFinite(date.getTime())) {
    throw invalidResponse('Upload-Expires is not a valid HTTP date')
  }

  return date.toISOString()
}

function parseRetryAfter(value: string | null, now: Date): number | null {
  if (value === null) {
    return null
  }

  if (/^(?:0|[1-9]\d*)$/u.test(value)) {
    return Number(value) * 1_000
  }

  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? Math.max(0, date.getTime() - now.getTime()) : null
}

function resolveLocation(location: string, responseUrl: string, endpoint: string): string {
  const base = responseUrl || endpoint

  try {
    return new URL(location, base).toString()
  } catch {
    if (location.startsWith('/')) {
      return location
    }

    const separator = endpoint.lastIndexOf('/')
    return `${separator === -1 ? '' : endpoint.slice(0, separator + 1)}${location}`
  }
}

function invalidResponse(message: string): UploadClientError {
  return new UploadClientError({ code: 'invalid_response', message })
}
