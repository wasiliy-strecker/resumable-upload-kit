import { decodeBase64, encodeBase64 } from './base64.js'
import { TusProtocolError } from './errors.js'

export interface UploadMetadataEntry {
  readonly key: string
  readonly value: Uint8Array
}

export interface UploadMetadataLimits {
  readonly maximumEntries?: number
  readonly maximumHeaderBytes?: number
  readonly maximumKeyBytes?: number
  readonly maximumValueBytes?: number
}

export const defaultUploadMetadataLimits = Object.freeze({
  maximumEntries: 16,
  maximumHeaderBytes: 8_192,
  maximumKeyBytes: 64,
  maximumValueBytes: 4_096,
})

export function parseUploadMetadata(
  value: string | null | undefined,
  limits: UploadMetadataLimits = {},
): readonly UploadMetadataEntry[] {
  if (value === null || value === undefined || value === '') {
    return Object.freeze([])
  }

  const resolved = resolveLimits(limits)

  if (byteLength(value) > resolved.maximumHeaderBytes || /[\r\n]/u.test(value)) {
    throw invalidMetadata('Upload-Metadata is too large or contains a line break')
  }

  const rawEntries = value.split(',')

  if (rawEntries.length > resolved.maximumEntries) {
    throw invalidMetadata(`Upload-Metadata exceeds ${resolved.maximumEntries} entries`)
  }

  const keys = new Set<string>()
  const entries = rawEntries.map((rawEntry) => {
    const entry = rawEntry.trim()
    const separator = entry.indexOf(' ')
    const key = separator === -1 ? entry : entry.slice(0, separator)
    const encodedValue = separator === -1 ? '' : entry.slice(separator + 1)

    if (!isMetadataKey(key) || byteLength(key) > resolved.maximumKeyBytes) {
      throw invalidMetadata(`Invalid Upload-Metadata key: ${key || '<empty>'}`)
    }

    if (keys.has(key)) {
      throw invalidMetadata(`Duplicate Upload-Metadata key: ${key}`)
    }

    const decoded = decodeBase64(encodedValue)

    if (decoded === null || decoded.byteLength > resolved.maximumValueBytes) {
      throw invalidMetadata(`Invalid or oversized Base64 value for Upload-Metadata key: ${key}`)
    }

    keys.add(key)
    return Object.freeze({ key, value: decoded })
  })

  return Object.freeze(entries)
}

export function serializeUploadMetadata(
  entries: readonly UploadMetadataEntry[],
  limits: UploadMetadataLimits = {},
): string {
  const serialized = entries.map(({ key, value }) => `${key} ${encodeBase64(value)}`).join(',')

  parseUploadMetadata(serialized, limits)
  return serialized
}

function resolveLimits(limits: UploadMetadataLimits): Required<UploadMetadataLimits> {
  return {
    maximumEntries: positiveLimit(
      limits.maximumEntries,
      defaultUploadMetadataLimits.maximumEntries,
    ),
    maximumHeaderBytes: positiveLimit(
      limits.maximumHeaderBytes,
      defaultUploadMetadataLimits.maximumHeaderBytes,
    ),
    maximumKeyBytes: positiveLimit(
      limits.maximumKeyBytes,
      defaultUploadMetadataLimits.maximumKeyBytes,
    ),
    maximumValueBytes: positiveLimit(
      limits.maximumValueBytes,
      defaultUploadMetadataLimits.maximumValueBytes,
    ),
  }
}

function positiveLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback
  }

  if (!Number.isSafeInteger(value) || value < 1) {
    throw invalidMetadata('Upload-Metadata limits must be positive safe integers')
  }

  return value
}

function isMetadataKey(value: string): boolean {
  if (value.length === 0) {
    return false
  }

  for (const character of value) {
    const code = character.charCodeAt(0)

    if (code < 0x21 || code > 0x7e || character === ',') {
      return false
    }
  }

  return true
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function invalidMetadata(message: string): TusProtocolError {
  return new TusProtocolError({ code: 'invalid_metadata', message, status: 400 })
}
