import {
  tusChecksumAlgorithms,
  tusExtensions,
  tusHeader,
  tusOffsetContentType,
  tusVersion,
  type TusChecksumAlgorithm,
  type TusExtension,
} from './constants.js'
import { TusProtocolError } from './errors.js'

export interface IntegerHeaderOptions {
  readonly maximum?: number
}

export interface TusOptionsHeaderInput {
  readonly checksumAlgorithms?: readonly TusChecksumAlgorithm[]
  readonly extensions?: readonly TusExtension[]
  readonly maximumUploadSize: number
}

export function parseTusResumable(value: string | null | undefined): typeof tusVersion {
  if (value !== tusVersion) {
    throw new TusProtocolError({
      code: 'unsupported_version',
      headers: { [tusHeader.version]: tusVersion },
      message: `Expected ${tusHeader.resumable}: ${tusVersion}`,
      status: 412,
    })
  }

  return tusVersion
}

export function parseNonNegativeIntegerHeader(
  value: string | null | undefined,
  name: string,
  options: IntegerHeaderOptions = {},
): number {
  if (value === null || value === undefined || !/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw invalidHeader(name, 'must be a non-negative decimal integer')
  }

  const parsed = Number(value)
  const maximum = options.maximum ?? Number.MAX_SAFE_INTEGER

  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw invalidHeader(name, `must not exceed ${maximum}`)
  }

  return parsed
}

export function parseUploadLength(
  value: string | null | undefined,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  return parseNonNegativeIntegerHeader(value, tusHeader.uploadLength, { maximum })
}

export function parseUploadOffset(value: string | null | undefined): number {
  return parseNonNegativeIntegerHeader(value, tusHeader.uploadOffset)
}

export function assertOffsetContentType(value: string | null | undefined): void {
  if (value?.toLowerCase() !== tusOffsetContentType) {
    throw new TusProtocolError({
      code: 'unsupported_media_type',
      message: `Expected Content-Type: ${tusOffsetContentType}`,
      status: 415,
    })
  }
}

export function createTusResponseHeaders(): Readonly<Record<string, string>> {
  return Object.freeze({ [tusHeader.resumable]: tusVersion })
}

export function createTusOptionsHeaders(
  input: TusOptionsHeaderInput,
): Readonly<Record<string, string>> {
  const extensions = input.extensions ?? []
  const checksumAlgorithms = input.checksumAlgorithms ?? []

  validateCapabilities(extensions, checksumAlgorithms)

  const maximumUploadSize = input.maximumUploadSize

  if (!Number.isSafeInteger(maximumUploadSize) || maximumUploadSize < 0) {
    throw new TusProtocolError({
      code: 'invalid_header',
      message: 'Maximum upload size must be a non-negative safe integer',
      status: 500,
    })
  }

  const headers: Record<string, string> = {
    [tusHeader.maxSize]: String(maximumUploadSize),
    [tusHeader.resumable]: tusVersion,
    [tusHeader.version]: tusVersion,
  }

  if (extensions.length > 0) {
    headers[tusHeader.extension] = extensions.join(',')
  }

  if (checksumAlgorithms.length > 0) {
    headers[tusHeader.checksumAlgorithm] = checksumAlgorithms.join(',')
  }

  return Object.freeze(headers)
}

function validateCapabilities(
  extensions: readonly TusExtension[],
  checksumAlgorithms: readonly TusChecksumAlgorithm[],
): void {
  const validExtensions =
    new Set(extensions).size === extensions.length &&
    extensions.every((extension) => tusExtensions.includes(extension))
  const validAlgorithms =
    new Set(checksumAlgorithms).size === checksumAlgorithms.length &&
    checksumAlgorithms.every((algorithm) => tusChecksumAlgorithms.includes(algorithm))
  const checksumConfigurationMatches =
    extensions.includes('checksum') === checksumAlgorithms.length > 0

  if (!validExtensions || !validAlgorithms || !checksumConfigurationMatches) {
    throw new TusProtocolError({
      code: 'invalid_header',
      message: 'Tus capability configuration is inconsistent',
      status: 500,
    })
  }
}

function invalidHeader(name: string, expectation: string): TusProtocolError {
  return new TusProtocolError({
    code: 'invalid_header',
    message: `${name} ${expectation}`,
    status: 400,
  })
}
