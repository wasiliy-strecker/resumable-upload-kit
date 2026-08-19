import { afterEach, describe, expect, it, vi } from 'vitest'

import { createBlobUploadSource, createFileUploadSource, digestSha256 } from '../src/source.js'

describe('browser upload sources', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('wraps Blobs with immutable identity and bounded slicing', async () => {
    const source = createBlobUploadSource(new Blob(['abcdef']), 'document-v1')

    expect(source).toMatchObject({ fingerprint: 'document-v1', size: 6 })
    expect(Object.isFrozen(source)).toBe(true)
    expect(await source.slice(1, 4).text()).toBe('bcd')
    expect(() => source.slice(-1, 2)).toThrow(RangeError)
    expect(() => source.slice(3, 2)).toThrow(RangeError)
    expect(() => source.slice(0, 7)).toThrow(RangeError)
  })

  it('creates deterministic sampled File fingerprints without reading the middle', async () => {
    const file = new File(['first-middle-last'], 'report.pdf', {
      lastModified: 1_776_596_400_000,
      type: 'application/pdf',
    })
    const first = await createFileUploadSource(file, { sampleBytes: 5 })
    const second = await createFileUploadSource(file, { sampleBytes: 5 })
    const renamed = await createFileUploadSource(
      new File(['first-middle-last'], 'renamed.pdf', {
        lastModified: file.lastModified,
        type: file.type,
      }),
      { sampleBytes: 5 },
    )

    expect(first.fingerprint).toMatch(/^file-sample-sha256:[0-9a-f]{64}$/u)
    expect(second.fingerprint).toBe(first.fingerprint)
    expect(renamed.fingerprint).not.toBe(first.fingerprint)
    expect(await first.slice(0, 5).text()).toBe('first')
  })

  it('accepts an application-provided strong fingerprint', async () => {
    const source = await createFileUploadSource(new File(['data'], 'data.bin'), {
      fingerprint: 'sha256:application-owned',
      sampleBytes: 0,
    })
    expect(source.fingerprint).toBe('sha256:application-owned')
  })

  it('calculates SHA-256 through Web Crypto', async () => {
    const digest = await digestSha256(new Blob(['hello']))
    expect(toHex(digest)).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
  })

  it('validates fingerprints, sample sizes, source types, and Web Crypto availability', async () => {
    expect(() => createBlobUploadSource(new Blob(), ' ')).toThrow('fingerprint')
    expect(() => createBlobUploadSource(new Blob(), 'x'.repeat(1_025))).toThrow('fingerprint')
    expect(() => createBlobUploadSource({} as Blob, 'valid')).toThrow(TypeError)
    await expect(
      createFileUploadSource(new File(['data'], 'data.bin'), { sampleBytes: 0 }),
    ).rejects.toThrow('sampleBytes')

    vi.stubGlobal('crypto', undefined)
    await expect(digestSha256(new Blob(['data']))).rejects.toThrow('Web Crypto')
  })
})

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
