import type { UploadSource } from './types.js'

export interface CreateFileUploadSourceOptions {
  readonly fingerprint?: string
  readonly sampleBytes?: number
}

const defaultSampleBytes = 64 * 1_024

export async function createFileUploadSource(
  file: File,
  options: CreateFileUploadSourceOptions = {},
): Promise<UploadSource> {
  assertBlob(file)
  const fingerprint =
    options.fingerprint ?? (await createSampledFileFingerprint(file, options.sampleBytes))
  return createBlobUploadSource(file, fingerprint)
}

export function createBlobUploadSource(blob: Blob, fingerprint: string): UploadSource {
  assertBlob(blob)

  if (fingerprint.trim().length === 0 || fingerprint.length > 1_024) {
    throw new Error('Upload source fingerprint must contain between 1 and 1024 characters')
  }

  return Object.freeze({
    fingerprint,
    size: blob.size,
    slice: (start: number, end: number) => {
      assertSlice(start, end, blob.size)
      return blob.slice(start, end)
    },
  })
}

async function createSampledFileFingerprint(
  file: File,
  sampleBytes = defaultSampleBytes,
): Promise<string> {
  if (!Number.isSafeInteger(sampleBytes) || sampleBytes < 1) {
    throw new Error('sampleBytes must be a positive safe integer')
  }

  const firstEnd = Math.min(sampleBytes, file.size)
  const lastStart = Math.max(firstEnd, file.size - sampleBytes)
  const identity = new TextEncoder().encode(
    `${file.name}\u0000${file.size}\u0000${file.lastModified}\u0000${file.type}\u0000`,
  )
  const sampled = new Blob([identity, file.slice(0, firstEnd), file.slice(lastStart)])
  const digest = await digestSha256(sampled)
  return `file-sample-sha256:${toHex(digest)}`
}

export async function digestSha256(blob: Blob): Promise<Uint8Array> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Web Crypto SubtleCrypto is required for upload checksums')
  }

  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))
}

function assertBlob(value: Blob): void {
  if (!(value instanceof Blob) || !Number.isSafeInteger(value.size) || value.size < 0) {
    throw new TypeError('Upload source must be a valid Blob or File')
  }
}

function assertSlice(start: number, end: number, size: number): void {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    end > size
  ) {
    throw new RangeError('Upload source slice is outside the Blob boundary')
  }
}

function toHex(bytes: Uint8Array): string {
  let value = ''

  for (const byte of bytes) {
    value += byte.toString(16).padStart(2, '0')
  }

  return value
}
