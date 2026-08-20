import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { TusProtocolError } from '@resumable-upload-kit/protocol'
import type {
  AppendUploadInput,
  CreateUploadInput,
  UploadRecord,
  UploadService,
} from '@resumable-upload-kit/server'

import { createApiApp } from '../src/app.js'
import type { AccessTokenVerifier } from '../src/auth.js'
import { createJwtFixture } from './jwt-fixture.js'

const uploadId = '018f1111-1111-7111-8111-111111111111'

describe('authenticated demo API', () => {
  const apps: FastifyInstance[] = []

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()))
  })

  it('keeps liveness public and reports dependency readiness without leaking details', async () => {
    const fixture = await createJwtFixture()
    let ready = false
    const app = createApiApp({
      accessTokenVerifier: fixture.verifier,
      readiness: async () => {
        if (!ready) throw new Error('password=database-secret')
      },
      service: new OwnedStubService(),
    })
    apps.push(app)

    const live = await app.inject({ method: 'GET', url: '/health/live' })
    const unavailable = await app.inject({ method: 'GET', url: '/health/ready' })
    ready = true
    const available = await app.inject({ method: 'GET', url: '/health/ready' })

    expect(live).toMatchObject({ statusCode: 200 })
    expect(live.json()).toEqual({ status: 'ok' })
    expect(unavailable.statusCode).toBe(503)
    expect(unavailable.headers['cache-control']).toBe('no-store')
    expect(unavailable.headers['content-type']).toContain('application/problem+json')
    expect(unavailable.body).not.toContain('database-secret')
    expect(available.json()).toEqual({ status: 'ready' })
  })

  it('authenticates upload creation and hides one owner resource from another', async () => {
    const fixture = await createJwtFixture()
    const service = new OwnedStubService()
    const app = createApiApp({ accessTokenVerifier: fixture.verifier, service })
    apps.push(app)
    const aliceToken = await fixture.sign({ subject: 'user-alice' })
    const bobToken = await fixture.sign({ subject: 'user-bob' })
    const created = await app.inject({
      headers: uploadHeaders(aliceToken, { 'upload-length': '5' }),
      method: 'POST',
      url: '/uploads',
    })

    expect(created.statusCode).toBe(201)
    expect(created.headers.location).toBe(`/uploads/${uploadId}`)
    expect(service.lastCreatedOwner).toBe('user-alice')

    const owned = await app.inject({
      headers: uploadHeaders(aliceToken),
      method: 'HEAD',
      url: `/uploads/${uploadId}`,
    })
    const foreign = await app.inject({
      headers: uploadHeaders(bobToken),
      method: 'HEAD',
      url: `/uploads/${uploadId}`,
    })

    expect(owned.statusCode).toBe(200)
    expect(owned.headers['upload-length']).toBe('5')
    expect(foreign.statusCode).toBe(404)
  })

  it('rejects missing, malformed, invalid, and expired credentials uniformly', async () => {
    const fixture = await createJwtFixture()
    const app = createApiApp({
      accessTokenVerifier: fixture.verifier,
      service: new OwnedStubService(),
    })
    apps.push(app)
    const now = Math.floor(Date.now() / 1_000)
    const expired = await fixture.sign({ expiresAt: now - 30, issuedAt: now - 60 })
    const authorizations = [undefined, 'Basic value', 'Bearer not-a-jwt', `Bearer ${expired}`]

    for (const authorization of authorizations) {
      const response = await app.inject({
        headers: {
          ...(authorization === undefined ? {} : { authorization }),
          'tus-resumable': '1.0.0',
          'upload-length': '5',
        },
        method: 'POST',
        url: '/uploads',
      })

      expect(response.statusCode).toBe(401)
      expect(response.json()).toMatchObject({ code: 'unauthorized' })
    }
  })

  it('leaves tus capability discovery unauthenticated', async () => {
    const app = createApiApp({
      accessTokenVerifier: rejectingVerifier(),
      service: new OwnedStubService(),
    })
    apps.push(app)

    const response = await app.inject({ method: 'OPTIONS', url: '/uploads' })

    expect(response.statusCode).toBe(204)
    expect(response.headers['tus-version']).toBe('1.0.0')
  })

  it('turns identity infrastructure failures into a stable server error', async () => {
    const app = createApiApp({
      accessTokenVerifier: {
        async verify(): Promise<string> {
          throw new Error('private JWKS network detail')
        },
      },
      service: new OwnedStubService(),
    })
    apps.push(app)
    const response = await app.inject({
      headers: uploadHeaders('unavailable', { 'upload-length': '5' }),
      method: 'POST',
      url: '/uploads',
    })

    expect(response.statusCode).toBe(500)
    expect(response.body).not.toContain('private JWKS')
  })
})

class OwnedStubService implements UploadService {
  readonly limits = {
    expirationMs: 86_400_000,
    leaseDurationMs: 30_000,
    maximumChunkBytes: 5_242_880,
    maximumUploadBytes: 262_144_000,
  }
  lastCreatedOwner: string | null = null
  #upload: UploadRecord | null = null

  async append(_input: AppendUploadInput): Promise<UploadRecord> {
    return this.requireUpload()
  }

  async create(input: CreateUploadInput): Promise<UploadRecord> {
    this.lastCreatedOwner = input.ownerId
    this.#upload = {
      createdAt: new Date('2026-08-20T10:00:00.000Z'),
      expiresAt: new Date('2026-08-21T10:00:00.000Z'),
      id: uploadId,
      leaseExpiresAt: null,
      leaseId: null,
      length: input.length,
      metadata: input.metadata,
      offset: 0,
      ownerId: input.ownerId,
      status: 'active',
      updatedAt: new Date('2026-08-20T10:00:00.000Z'),
    }
    return this.#upload
  }

  async head(requestedUploadId: string, ownerId: string): Promise<UploadRecord> {
    const upload = this.requireUpload()

    if (requestedUploadId !== upload.id || ownerId !== upload.ownerId) {
      throw new TusProtocolError({
        code: 'upload_not_found',
        message: 'Upload was not found',
        status: 404,
      })
    }

    return upload
  }

  async terminate(_uploadId: string, _ownerId: string): Promise<void> {
    this.#upload = null
  }

  private requireUpload(): UploadRecord {
    if (this.#upload === null) {
      throw new Error('Test upload has not been created')
    }

    return this.#upload
  }
}

function uploadHeaders(
  token: string,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'tus-resumable': '1.0.0', ...extra }
}

function rejectingVerifier(): AccessTokenVerifier {
  return {
    async verify(): Promise<string> {
      throw new Error('Verifier must not run for OPTIONS')
    },
  }
}
