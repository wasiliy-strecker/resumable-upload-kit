import { describe, expect, it } from 'vitest'

import {
  parseUploadChecksum,
  serializeUploadChecksum,
  type TusChecksumAlgorithm,
} from '../src/index.js'

describe('Upload-Checksum', () => {
  it.each([
    ['sha1', 20],
    ['sha256', 32],
  ] satisfies readonly (readonly [TusChecksumAlgorithm, number])[])(
    'round-trips %s digests',
    (algorithm, length) => {
      const checksum = { algorithm, digest: Uint8Array.from({ length }, (_, index) => index) }
      const serialized = serializeUploadChecksum(checksum)

      expect(parseUploadChecksum(serialized)).toEqual(checksum)
    },
  )

  it('distinguishes unsupported algorithms from malformed digest values', () => {
    expect(() => parseUploadChecksum('md5 AAAAAAAAAAAAAAAAAAAAAA==')).toThrow(
      expect.objectContaining({ code: 'unsupported_checksum_algorithm', status: 400 }),
    )
    expect(() => parseUploadChecksum('SHA1 AAAAAAAAAAAAAAAAAAAAAAAAAAA=')).toThrow(
      expect.objectContaining({ code: 'unsupported_checksum_algorithm' }),
    )

    for (const value of [
      undefined,
      null,
      '',
      'sha1',
      ' sha1',
      'sha1  ',
      'sha1 not-base64',
      'sha1 YQ==',
    ]) {
      expect(() => parseUploadChecksum(value)).toThrow(
        expect.objectContaining({ code: 'invalid_header', status: 400 }),
      )
    }
  })

  it('rejects invalid digest lengths during serialization', () => {
    expect(() =>
      serializeUploadChecksum({ algorithm: 'sha256', digest: new Uint8Array(31) }),
    ).toThrow('invalid length')
  })
})
