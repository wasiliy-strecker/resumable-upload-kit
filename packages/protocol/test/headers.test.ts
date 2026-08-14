import { describe, expect, it } from 'vitest'

import {
  TusProtocolError,
  assertOffsetContentType,
  createTusOptionsHeaders,
  createTusResponseHeaders,
  parseNonNegativeIntegerHeader,
  parseTusResumable,
  parseUploadLength,
  parseUploadOffset,
  tusOffsetContentType,
  tusVersion,
} from '../src/index.js'

describe('tus headers', () => {
  it('accepts the supported tus version and reports alternatives for every mismatch', () => {
    expect(parseTusResumable(tusVersion)).toBe(tusVersion)

    for (const value of [undefined, null, '', '0.2.2']) {
      try {
        parseTusResumable(value)
        expect.fail('Expected the version to be rejected')
      } catch (error) {
        expect(error).toMatchObject({
          code: 'unsupported_version',
          headers: { 'Tus-Version': tusVersion },
          status: 412,
        })
      }
    }
  })

  it('parses safe non-negative decimal integer headers', () => {
    expect(parseNonNegativeIntegerHeader('0', 'Example')).toBe(0)
    expect(parseUploadOffset('42')).toBe(42)
    expect(parseUploadLength('250', 250)).toBe(250)

    for (const value of [undefined, null, '', '-1', '+1', '01', '1.5', ' 1', '1 ']) {
      expect(() => parseNonNegativeIntegerHeader(value, 'Example')).toThrow(TusProtocolError)
    }

    expect(() => parseUploadLength('251', 250)).toThrow('must not exceed 250')
    expect(() => parseUploadOffset(String(Number.MAX_SAFE_INTEGER + 1))).toThrow('must not exceed')
  })

  it('requires the offset payload media type without parameters', () => {
    expect(() => assertOffsetContentType(tusOffsetContentType)).not.toThrow()
    expect(() => assertOffsetContentType('APPLICATION/OFFSET+OCTET-STREAM')).not.toThrow()

    for (const value of [
      undefined,
      null,
      'application/octet-stream',
      `${tusOffsetContentType};x=1`,
    ]) {
      expect(() => assertOffsetContentType(value)).toThrow(
        expect.objectContaining({ code: 'unsupported_media_type', status: 415 }),
      )
    }
  })

  it('creates immutable core and capability response headers', () => {
    expect(createTusResponseHeaders()).toEqual({ 'Tus-Resumable': '1.0.0' })
    expect(
      createTusOptionsHeaders({
        checksumAlgorithms: ['sha1', 'sha256'],
        extensions: ['creation', 'checksum', 'expiration', 'termination'],
        maximumUploadSize: 262_144_000,
      }),
    ).toEqual({
      'Tus-Checksum-Algorithm': 'sha1,sha256',
      'Tus-Extension': 'creation,checksum,expiration,termination',
      'Tus-Max-Size': '262144000',
      'Tus-Resumable': '1.0.0',
      'Tus-Version': '1.0.0',
    })
    expect(Object.isFrozen(createTusOptionsHeaders({ maximumUploadSize: 0 }))).toBe(true)
    expect(createTusOptionsHeaders({ maximumUploadSize: 10 })).not.toHaveProperty('Tus-Extension')

    for (const value of [-1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(() => createTusOptionsHeaders({ maximumUploadSize: value })).toThrow(
        expect.objectContaining({ code: 'invalid_header', status: 500 }),
      )
    }

    expect(() =>
      createTusOptionsHeaders({ extensions: ['checksum'], maximumUploadSize: 10 }),
    ).toThrow('inconsistent')
    expect(() =>
      createTusOptionsHeaders({ checksumAlgorithms: ['sha256'], maximumUploadSize: 10 }),
    ).toThrow('inconsistent')
  })

  it('preserves structured protocol error details and causes', () => {
    const cause = new Error('socket closed')
    const error = new TusProtocolError({
      cause,
      code: 'upload_locked',
      headers: { 'Retry-After': '1' },
      message: 'Upload is leased',
      status: 423,
    })

    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('TusProtocolError')
    expect(error.cause).toBe(cause)
    expect(error).toMatchObject({
      code: 'upload_locked',
      headers: { 'Retry-After': '1' },
      message: 'Upload is leased',
      status: 423,
    })
    expect(Object.isFrozen(error.headers)).toBe(true)
  })
})
