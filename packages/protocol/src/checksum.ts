import { decodeBase64, encodeBase64 } from './base64.js'
import { tusChecksumAlgorithms, type TusChecksumAlgorithm } from './constants.js'
import { TusProtocolError } from './errors.js'

const checksumBytes: Readonly<Record<TusChecksumAlgorithm, number>> = {
  sha1: 20,
  sha256: 32,
}

export interface UploadChecksum {
  readonly algorithm: TusChecksumAlgorithm
  readonly digest: Uint8Array
}

export function parseUploadChecksum(value: string | null | undefined): UploadChecksum {
  if (value === null || value === undefined) {
    throw invalidChecksum('Upload-Checksum is required')
  }

  const separator = value.indexOf(' ')

  if (separator <= 0 || value.indexOf(' ', separator + 1) !== -1) {
    throw invalidChecksum('Upload-Checksum must contain an algorithm and Base64 digest')
  }

  const algorithm = value.slice(0, separator)

  if (!isChecksumAlgorithm(algorithm)) {
    throw new TusProtocolError({
      code: 'unsupported_checksum_algorithm',
      message: `Unsupported checksum algorithm: ${algorithm}`,
      status: 400,
    })
  }

  const digest = decodeBase64(value.slice(separator + 1))

  if (digest === null || digest.byteLength !== checksumBytes[algorithm]) {
    throw invalidChecksum(`${algorithm} digest has an invalid Base64 value or length`)
  }

  return { algorithm, digest }
}

export function serializeUploadChecksum(checksum: UploadChecksum): string {
  if (checksum.digest.byteLength !== checksumBytes[checksum.algorithm]) {
    throw invalidChecksum(`${checksum.algorithm} digest has an invalid length`)
  }

  return `${checksum.algorithm} ${encodeBase64(checksum.digest)}`
}

function isChecksumAlgorithm(value: string): value is TusChecksumAlgorithm {
  return tusChecksumAlgorithms.some((algorithm) => algorithm === value)
}

function invalidChecksum(message: string): TusProtocolError {
  return new TusProtocolError({ code: 'invalid_header', message, status: 400 })
}
