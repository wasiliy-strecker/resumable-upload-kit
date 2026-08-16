import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { registerResumableUploadRoutes } from '../src/fastify.js'
import type { UploadRecord, UploadService } from '../src/types.js'

const uploadId = '018f1111-1111-7111-8111-111111111111'
const activeUpload: UploadRecord = {
  createdAt: new Date('2026-08-16T10:00:00Z'),
  expiresAt: new Date('2026-08-17T10:00:00Z'),
  id: uploadId,
  leaseExpiresAt: null,
  leaseId: null,
  length: 5,
  metadata: [{ key: 'filename', value: new TextEncoder().encode('demo.txt') }],
  offset: 0,
  ownerId: 'owner',
  status: 'active',
  updatedAt: new Date('2026-08-16T10:00:00Z'),
}

describe('Fastify tus adapter', () => {
  const apps: FastifyInstance[] = []

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()))
  })

  it('advertises the implemented tus extensions and limits', async () => {
    const { app } = await createApp()
    apps.push(app)
    const response = await app.inject({ method: 'OPTIONS', url: '/uploads' })

    expect(response.statusCode).toBe(204)
    expect(response.headers).toMatchObject({
      'tus-checksum-algorithm': 'sha1,sha256',
      'tus-extension': 'creation,checksum,expiration,termination',
      'tus-max-size': '262144000',
      'tus-resumable': '1.0.0',
      'tus-version': '1.0.0',
    })
  })

  it('creates an owned upload and returns its opaque location', async () => {
    const { app, service } = await createApp()
    apps.push(app)
    const response = await app.inject({
      headers: {
        'tus-resumable': '1.0.0',
        'upload-length': '5',
        'upload-metadata': 'filename ZGVtby50eHQ=',
        authorization: 'Bearer owner',
      },
      method: 'POST',
      url: '/uploads',
    })

    expect(response.statusCode).toBe(201)
    expect(response.headers).toMatchObject({
      location: `/uploads/${uploadId}`,
      'tus-resumable': '1.0.0',
      'upload-expires': 'Mon, 17 Aug 2026 10:00:00 GMT',
    })
    expect(service.created).toMatchObject({ length: 5, ownerId: 'owner' })
  })

  it('reports offsets and metadata without allowing caches', async () => {
    const { app } = await createApp()
    apps.push(app)
    const response = await app.inject({
      headers: { 'tus-resumable': '1.0.0', authorization: 'Bearer owner' },
      method: 'HEAD',
      url: `/uploads/${uploadId}`,
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers).toMatchObject({
      'cache-control': 'no-store',
      'upload-length': '5',
      'upload-metadata': 'filename ZGVtby50eHQ=',
      'upload-offset': '0',
    })
  })

  it('streams PATCH payloads and returns the newly confirmed offset', async () => {
    const { app, service } = await createApp()
    apps.push(app)
    const response = await app.inject({
      headers: {
        'content-length': '5',
        'content-type': 'application/offset+octet-stream',
        'tus-resumable': '1.0.0',
        'upload-checksum': 'sha256 LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=',
        'upload-offset': '0',
        authorization: 'Bearer owner',
      },
      method: 'PATCH',
      payload: Buffer.from('hello'),
      url: `/uploads/${uploadId}`,
    })

    expect(response.statusCode).toBe(204)
    expect(response.headers['upload-offset']).toBe('5')
    expect(service.appended).toMatchObject({ contentLength: 5, offset: 0, ownerId: 'owner' })
    expect(service.appended?.checksum?.algorithm).toBe('sha256')
  })

  it('terminates resources and enforces authentication', async () => {
    const { app, service } = await createApp()
    apps.push(app)
    const unauthorized = await app.inject({
      headers: { 'tus-resumable': '1.0.0' },
      method: 'DELETE',
      url: `/uploads/${uploadId}`,
    })
    expect(unauthorized.statusCode).toBe(401)
    expect(unauthorized.json()).toMatchObject({ code: 'unauthorized' })

    const response = await app.inject({
      headers: { 'tus-resumable': '1.0.0', authorization: 'Bearer owner' },
      method: 'DELETE',
      url: `/uploads/${uploadId}`,
    })
    expect(response.statusCode).toBe(204)
    expect(service.terminated).toEqual({ ownerId: 'owner', uploadId })
  })

  it.each([
    [
      'POST body',
      {
        headers: headers({
          'content-length': '1',
          'content-type': 'application/octet-stream',
          'upload-length': '5',
        }),
        method: 'POST',
        payload: 'x',
        url: '/uploads',
      },
      400,
    ],
    [
      'missing version',
      {
        headers: { authorization: 'Bearer owner', 'upload-length': '5' },
        method: 'POST',
        url: '/uploads',
      },
      412,
    ],
    [
      'wrong PATCH media type',
      {
        headers: headers({
          'content-length': '1',
          'content-type': 'application/octet-stream',
          'upload-offset': '0',
        }),
        method: 'PATCH',
        payload: 'x',
        url: `/uploads/${uploadId}`,
      },
      415,
    ],
    [
      'unknown PATCH media type',
      {
        headers: headers({
          'content-length': '1',
          'content-type': 'image/png',
          'upload-offset': '0',
        }),
        method: 'PATCH',
        payload: 'x',
        url: `/uploads/${uploadId}`,
      },
      415,
    ],
    [
      'empty PATCH',
      {
        headers: headers({
          'content-length': '0',
          'content-type': 'application/offset+octet-stream',
          'upload-offset': '0',
        }),
        method: 'PATCH',
        payload: '',
        url: `/uploads/${uploadId}`,
      },
      400,
    ],
  ] as const)('returns a problem response for %s', async (_name, request, status) => {
    const { app } = await createApp()
    apps.push(app)
    const response = await app.inject(request)
    expect(response.statusCode).toBe(status)
    expect(response.headers['content-type']).toContain('application/problem+json')
    expect(response.headers['tus-resumable']).toBe('1.0.0')
  })

  it('hides unexpected service failures behind a stable problem response', async () => {
    const { app, service } = await createApp()
    apps.push(app)
    service.headError = new Error('sensitive database details')
    const response = await app.inject({
      headers: headers(),
      method: 'HEAD',
      url: `/uploads/${uploadId}`,
    })

    expect(response.statusCode).toBe(500)
    expect(response.headers['tus-resumable']).toBe('1.0.0')
    expect(response.body).not.toContain('sensitive')
  })

  it('validates adapter paths before route registration', async () => {
    const app = Fastify()
    apps.push(app)
    expect(() =>
      registerResumableUploadRoutes(app, {
        basePath: '/invalid/',
        resolveOwner: () => 'owner',
        service: new StubService(),
      }),
    ).toThrow('basePath')
  })
})

async function createApp() {
  const app = Fastify()
  const service = new StubService()
  registerResumableUploadRoutes(app, {
    resolveOwner: (request) => {
      const authorization = request.headers.authorization
      return authorization?.startsWith('Bearer ') ? authorization.slice(7) : null
    },
    service,
  })
  await app.ready()
  return { app, service }
}

class StubService implements UploadService {
  public appended: Parameters<UploadService['append']>[0] | null = null
  public created: Parameters<UploadService['create']>[0] | null = null
  public headError: Error | null = null
  public readonly limits = {
    expirationMs: 86_400_000,
    leaseDurationMs: 30_000,
    maximumChunkBytes: 5_242_880,
    maximumUploadBytes: 262_144_000,
  }
  public terminated: { ownerId: string; uploadId: string } | null = null

  public async create(input: Parameters<UploadService['create']>[0]): Promise<UploadRecord> {
    this.created = input
    return activeUpload
  }

  public async head(_uploadId: string, _ownerId: string): Promise<UploadRecord> {
    if (this.headError) throw this.headError
    return activeUpload
  }

  public async append(input: Parameters<UploadService['append']>[0]): Promise<UploadRecord> {
    this.appended = input
    for await (const _chunk of input.source) {
      // Drain the stream to exercise the adapter's byte-stream contract.
    }
    return { ...activeUpload, expiresAt: null, offset: 5, status: 'completed' }
  }

  public async terminate(uploadId: string, ownerId: string): Promise<void> {
    this.terminated = { ownerId, uploadId }
  }
}

function headers(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: 'Bearer owner',
    'tus-resumable': '1.0.0',
    ...overrides,
  }
}
