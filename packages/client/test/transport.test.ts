import { afterEach, describe, expect, it, vi } from 'vitest'

import { FetchTusTransport } from '../src/transport.js'
import type { FetchLike } from '../src/types.js'

const endpoint = 'https://uploads.example.test/uploads'
const uploadUrl = 'https://uploads.example.test/uploads/remote-1'
const now = new Date('2026-08-19T10:00:00.000Z')

describe('FetchTusTransport', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('creates a resource with controlled headers and resolves its Location', async () => {
    const recorder = new FetchRecorder([
      response(201, {
        Location: '/uploads/remote-1',
        'Tus-Resumable': '1.0.0',
        'Upload-Expires': 'Thu, 20 Aug 2026 10:00:00 GMT',
      }),
    ])
    const transport = createTransport(recorder.fetch, {
      resolveHeaders: () => ({
        Authorization: 'Bearer secret',
        'Content-Length': '999',
        'Upload-Offset': '999',
      }),
    })
    const remote = await transport.create({
      metadata: [{ key: 'filename', value: new TextEncoder().encode('demo.txt') }],
      signal: new AbortController().signal,
      size: 5,
    })

    expect(remote).toEqual({
      expiresAt: '2026-08-20T10:00:00.000Z',
      length: 5,
      offset: 0,
      uploadUrl,
    })
    const request = recorder.requests[0]
    expect(request).toBeDefined()
    expect(request?.input).toBe(endpoint)
    expect(request?.init.method).toBe('POST')
    expect(headersOf(request?.init)).toMatchObject({
      authorization: 'Bearer secret',
      'tus-resumable': '1.0.0',
      'upload-length': '5',
      'upload-metadata': 'filename ZGVtby50eHQ=',
    })
    expect(headersOf(request?.init)).not.toHaveProperty('content-length')
    expect(headersOf(request?.init)).not.toHaveProperty('upload-offset')
  })

  it('discovers offsets, appends checksummed Blobs, and terminates uploads', async () => {
    const recorder = new FetchRecorder([
      response(200, {
        'Tus-Resumable': '1.0.0',
        'Upload-Expires': 'Thu, 20 Aug 2026 10:00:00 GMT',
        'Upload-Length': '5',
        'Upload-Offset': '2',
      }),
      response(204, {
        'Tus-Resumable': '1.0.0',
        'Upload-Offset': '5',
      }),
      response(204, { 'Tus-Resumable': '1.0.0' }),
    ])
    const transport = createTransport(recorder.fetch)

    await expect(transport.head(uploadUrl, new AbortController().signal)).resolves.toMatchObject({
      length: 5,
      offset: 2,
    })
    await expect(
      transport.append({
        body: new Blob(['llo']),
        checksum: new Uint8Array(32),
        length: 5,
        offset: 2,
        signal: new AbortController().signal,
        uploadUrl,
      }),
    ).resolves.toMatchObject({ expiresAt: null, length: 5, offset: 5 })
    await expect(
      transport.terminate(uploadUrl, new AbortController().signal),
    ).resolves.toBeUndefined()

    expect(recorder.requests.map(({ init }) => init.method)).toEqual(['HEAD', 'PATCH', 'DELETE'])
    const patchHeaders = headersOf(recorder.requests[1]?.init)
    expect(patchHeaders).toMatchObject({
      'content-type': 'application/offset+octet-stream',
      'tus-resumable': '1.0.0',
      'upload-checksum': `sha256 ${'A'.repeat(43)}=`,
      'upload-offset': '2',
    })
    expect(patchHeaders).not.toHaveProperty('content-length')
  })

  it('supports same-origin relative endpoints without relying on Node location globals', async () => {
    const recorder = new FetchRecorder([
      response(201, { Location: '/uploads/remote-1', 'Tus-Resumable': '1.0.0' }),
    ])
    const transport = new FetchTusTransport({ endpoint: '/uploads', fetch: recorder.fetch })

    await expect(
      transport.create({ metadata: [], signal: new AbortController().signal, size: 0 }),
    ).resolves.toMatchObject({ uploadUrl: '/uploads/remote-1' })
  })

  it.each([
    [401, 'authentication_failed', false],
    [403, 'authentication_failed', false],
    [404, 'remote_not_found', false],
    [410, 'upload_expired', false],
    [409, 'protocol_error', true],
    [408, 'protocol_error', true],
    [423, 'protocol_error', true],
    [425, 'protocol_error', true],
    [429, 'protocol_error', true],
    [460, 'protocol_error', true],
    [500, 'network_error', true],
    [400, 'protocol_error', false],
  ] as const)('maps HTTP %i to %s', async (status, code, retryable) => {
    const recorder = new FetchRecorder([response(status)])
    const transport = createTransport(recorder.fetch)

    await expect(transport.head(uploadUrl, new AbortController().signal)).rejects.toMatchObject({
      code,
      retryable,
      status,
    })
  })

  it('parses numeric and HTTP-date Retry-After values', async () => {
    const numeric = createTransport(
      new FetchRecorder([response(423, { 'Retry-After': '30' })]).fetch,
    )
    await expect(numeric.head(uploadUrl, new AbortController().signal)).rejects.toMatchObject({
      retryAfterMs: 30_000,
    })

    const dated = createTransport(
      new FetchRecorder([response(423, { 'Retry-After': 'Wed, 19 Aug 2026 10:00:05 GMT' })]).fetch,
    )
    await expect(dated.head(uploadUrl, new AbortController().signal)).rejects.toMatchObject({
      retryAfterMs: 5_000,
    })

    const invalid = createTransport(
      new FetchRecorder([response(423, { 'Retry-After': 'whenever' })]).fetch,
    )
    await expect(invalid.head(uploadUrl, new AbortController().signal)).rejects.toMatchObject({
      retryAfterMs: null,
    })
  })

  it.each([
    [
      'missing tus version',
      response(200, { 'Upload-Length': '5', 'Upload-Offset': '0' }),
      'valid Tus-Resumable',
    ],
    [
      'invalid length',
      response(200, {
        'Tus-Resumable': '1.0.0',
        'Upload-Length': 'wrong',
        'Upload-Offset': '0',
      }),
      'invalid Upload-Length',
    ],
    [
      'invalid offset',
      response(200, {
        'Tus-Resumable': '1.0.0',
        'Upload-Length': '5',
        'Upload-Offset': '6',
      }),
      'exceeds',
    ],
    [
      'invalid expiration',
      response(200, {
        'Tus-Resumable': '1.0.0',
        'Upload-Expires': 'tomorrow-ish',
        'Upload-Length': '5',
        'Upload-Offset': '0',
      }),
      'HTTP date',
    ],
  ] as const)('rejects a successful response with %s', async (_name, result, message) => {
    const transport = createTransport(new FetchRecorder([result]).fetch)
    await expect(transport.head(uploadUrl, new AbortController().signal)).rejects.toThrow(message)
  })

  it('rejects creation without Location and PATCH offsets beyond the upload', async () => {
    const createTransportInstance = createTransport(
      new FetchRecorder([response(201, { 'Tus-Resumable': '1.0.0' })]).fetch,
    )
    await expect(
      createTransportInstance.create({
        metadata: [],
        signal: new AbortController().signal,
        size: 1,
      }),
    ).rejects.toThrow('Location')

    const patchTransport = createTransport(
      new FetchRecorder([response(204, { 'Tus-Resumable': '1.0.0', 'Upload-Offset': '6' })]).fetch,
    )
    await expect(
      patchTransport.append({
        body: new Blob(['a']),
        checksum: new Uint8Array(32),
        length: 5,
        offset: 0,
        signal: new AbortController().signal,
        uploadUrl,
      }),
    ).rejects.toThrow('exceeds')
  })

  it('classifies fetch rejection as retryable but preserves cancellation', async () => {
    const network = createTransport(new FetchRecorder([new TypeError('Failed to fetch')]).fetch)
    await expect(network.head(uploadUrl, new AbortController().signal)).rejects.toMatchObject({
      code: 'network_error',
      retryable: true,
    })

    const controller = new AbortController()
    controller.abort(new DOMException('paused', 'AbortError'))
    const canceled = createTransport(
      new FetchRecorder([new DOMException('paused', 'AbortError')]).fetch,
    )
    await expect(canceled.head(uploadUrl, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
  })

  it('validates constructor dependencies and accepts async request headers', async () => {
    expect(() => new FetchTusTransport({ endpoint: ' ' })).toThrow('must not be empty')
    vi.stubGlobal('fetch', undefined)
    expect(() => new FetchTusTransport({ endpoint })).toThrow('Fetch is not available')

    const recorder = new FetchRecorder([
      response(200, {
        'Tus-Resumable': '1.0.0',
        'Upload-Length': '0',
        'Upload-Offset': '0',
      }),
    ])
    const transport = createTransport(recorder.fetch, {
      resolveHeaders: async () => ({ 'X-Request-Token': 'fresh' }),
    })
    await transport.head(uploadUrl, new AbortController().signal)
    expect(headersOf(recorder.requests[0]?.init)).toMatchObject({ 'x-request-token': 'fresh' })
  })

  it('falls back to string path resolution for non-URL endpoint values', async () => {
    const recorder = new FetchRecorder([
      response(201, { Location: 'remote-1', 'Tus-Resumable': '1.0.0' }),
      response(201, { Location: 'remote-2', 'Tus-Resumable': '1.0.0' }),
    ])
    const nested = new FetchTusTransport({ endpoint: 'api/uploads', fetch: recorder.fetch })
    await expect(
      nested.create({ metadata: [], signal: new AbortController().signal, size: 0 }),
    ).resolves.toMatchObject({ uploadUrl: 'api/remote-1' })
    const flat = new FetchTusTransport({ endpoint: 'uploads', fetch: recorder.fetch })
    await expect(
      flat.create({ metadata: [], signal: new AbortController().signal, size: 0 }),
    ).resolves.toMatchObject({ uploadUrl: 'remote-2' })
  })
})

interface TransportOverrides {
  readonly resolveHeaders?: () => HeadersInit | Promise<HeadersInit>
}

function createTransport(fetch: FetchLike, overrides: TransportOverrides = {}) {
  return new FetchTusTransport({
    clock: () => now,
    endpoint,
    fetch,
    ...overrides,
  })
}

class FetchRecorder {
  public readonly requests: Array<{ input: string; init: RequestInit }> = []

  public constructor(private readonly results: Array<Response | Error>) {}

  public readonly fetch: FetchLike = (input, init = {}) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    this.requests.push({ input: url, init })
    const result = this.results.shift()

    if (!result) {
      return Promise.reject(new Error('No fake response configured'))
    }

    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result)
  }
}

function response(status: number, headers: HeadersInit = {}): Response {
  return new Response(null, { headers, status })
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  const result: Record<string, string> = {}
  new Headers(init?.headers).forEach((value, key) => {
    result[key] = value
  })
  return result
}
