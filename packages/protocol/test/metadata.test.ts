import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  parseUploadMetadata,
  serializeUploadMetadata,
  type UploadMetadataEntry,
} from '../src/index.js'

describe('Upload-Metadata', () => {
  it('parses the specification example and empty metadata values', () => {
    const metadata = parseUploadMetadata(
      'filename d29ybGRfZG9taW5hdGlvbl9wbGFuLnBkZg==,is_confidential',
    )

    expect(new TextDecoder().decode(metadata[0]?.value)).toBe('world_domination_plan.pdf')
    expect(metadata.map(({ key, value }) => ({ key, value: [...value] }))).toEqual([
      {
        key: 'filename',
        value: [...new TextEncoder().encode('world_domination_plan.pdf')],
      },
      { key: 'is_confidential', value: [] },
    ])
    expect(Object.isFrozen(metadata)).toBe(true)
    expect(Object.isFrozen(metadata[0])).toBe(true)
  })

  it('returns an empty immutable collection when the header is absent', () => {
    for (const value of [undefined, null, '']) {
      const parsed = parseUploadMetadata(value)
      expect(parsed).toEqual([])
      expect(Object.isFrozen(parsed)).toBe(true)
    }
  })

  it('round-trips unique ASCII keys and arbitrary binary values', () => {
    const characters = ['a', 'b', 'c', 'x', 'y', 'z', '0', '1', '-', '_', '.']
    const key = fc
      .array(fc.constantFrom(...characters), { minLength: 1, maxLength: 12 })
      .map((value) => value.join(''))
    const entry = fc.record({ key, value: fc.uint8Array({ maxLength: 64 }) })

    fc.assert(
      fc.property(
        fc.uniqueArray(entry, { maxLength: 10, selector: ({ key: candidate }) => candidate }),
        (entries) => {
          expect(parseUploadMetadata(serializeUploadMetadata(entries))).toEqual(entries)
        },
      ),
    )
  })

  it.each([
    ['duplicate keys', 'filename YQ==,filename Yg=='],
    ['line breaks', 'filename YQ==\r\nInjected: yes'],
    ['spaces in keys', 'bad key YQ=='],
    ['commas creating empty entries', 'filename YQ==,'],
    ['non-ASCII keys', 'fïle YQ=='],
    ['malformed Base64', 'filename ***'],
    ['non-canonical Base64', 'filename YQ='],
  ])('rejects %s', (_case, value) => {
    expect(() => parseUploadMetadata(value)).toThrow(
      expect.objectContaining({ code: 'invalid_metadata', status: 400 }),
    )
  })

  it('enforces configurable entry, header, key, and decoded value limits', () => {
    expect(() => parseUploadMetadata('a,b', { maximumEntries: 1 })).toThrow('exceeds 1 entries')
    expect(() => parseUploadMetadata('long YQ==', { maximumKeyBytes: 2 })).toThrow('Invalid')
    expect(() => parseUploadMetadata('a YWJj', { maximumValueBytes: 2 })).toThrow('oversized')
    expect(() => parseUploadMetadata('a YQ==', { maximumHeaderBytes: 3 })).toThrow('too large')

    for (const limits of [
      { maximumEntries: 0 },
      { maximumHeaderBytes: 1.5 },
      { maximumKeyBytes: Number.POSITIVE_INFINITY },
      { maximumValueBytes: -1 },
    ]) {
      expect(() => parseUploadMetadata('a', limits)).toThrow('positive safe integers')
    }
  })

  it('validates entries passed to the serializer', () => {
    const duplicate: readonly UploadMetadataEntry[] = [
      { key: 'same', value: new Uint8Array() },
      { key: 'same', value: new Uint8Array() },
    ]

    expect(() => serializeUploadMetadata(duplicate)).toThrow('Duplicate')
    expect(() =>
      serializeUploadMetadata([{ key: 'invalid key', value: new Uint8Array() }]),
    ).toThrow('Invalid')
  })
})
