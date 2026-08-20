import type { FastifyRequest } from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import {
  AccessTokenRejectedError,
  createAccessTokenVerifier,
  createOwnerResolver,
  type AccessTokenVerifier,
} from '../src/auth.js'
import { createJwtFixture } from './jwt-fixture.js'

describe('JWT access token verification', () => {
  it('accepts a signed token with the configured claims', async () => {
    const fixture = await createJwtFixture()
    const token = await fixture.sign()

    await expect(fixture.verifier.verify(token)).resolves.toBe('user-alice')
  })

  it('rejects expired, mismatched, malformed, and invalid-subject tokens', async () => {
    const fixture = await createJwtFixture()
    const now = Math.floor(Date.now() / 1_000)
    const tokens = [
      await fixture.sign({ expiresAt: now - 30, issuedAt: now - 60 }),
      await fixture.sign({ audience: 'different-api' }),
      await fixture.sign({ subject: ' user-alice' }),
      await fixture.sign({ subject: 'x'.repeat(201) }),
      'not-a-jwt',
    ]

    for (const token of tokens) {
      await expect(fixture.verifier.verify(token)).rejects.toBeInstanceOf(AccessTokenRejectedError)
    }
  })

  it('does not disguise an unavailable key source as a bad credential', async () => {
    const fixture = await createJwtFixture()
    const unavailable = new Error('JWKS unavailable')
    const verifier = createAccessTokenVerifier({
      algorithms: ['RS256'],
      audience: fixture.audience,
      issuer: fixture.issuer,
      jwks: vi.fn(async () => {
        throw unavailable
      }),
      jwksUrl: 'https://identity.example.test/jwks.json',
    })

    await expect(verifier.verify(await fixture.sign())).rejects.toBe(unavailable)
  })
})

describe('Fastify owner resolution', () => {
  it('accepts case-insensitive Bearer syntax and returns the verified subject', async () => {
    const verify = vi.fn(async () => 'owner-1')
    const verifier: AccessTokenVerifier = { verify }
    const resolveOwner = createOwnerResolver(verifier)

    await expect(resolveOwner(request('bearer signed-token'))).resolves.toBe('owner-1')
    expect(verify).toHaveBeenCalledWith('signed-token')
  })

  it.each([undefined, '', 'Basic abc', 'Bearer', 'Bearer one two', `Bearer ${'x'.repeat(16_385)}`])(
    'rejects a missing or malformed authorization value',
    async (authorization) => {
      const verify = vi.fn(async () => 'owner-1')
      const verifier: AccessTokenVerifier = { verify }
      const resolveOwner = createOwnerResolver(verifier)

      await expect(resolveOwner(request(authorization))).resolves.toBeNull()
      expect(verify).not.toHaveBeenCalled()
    },
  )

  it('maps rejected credentials to anonymous without hiding infrastructure errors', async () => {
    const rejected = createOwnerResolver({
      verify: vi.fn(async () => {
        throw new AccessTokenRejectedError('invalid')
      }),
    })
    const unavailable = new Error('identity provider unavailable')
    const failed = createOwnerResolver({
      verify: vi.fn(async () => {
        throw unavailable
      }),
    })

    await expect(rejected(request('Bearer rejected'))).resolves.toBeNull()
    await expect(failed(request('Bearer unavailable'))).rejects.toBe(unavailable)
  })
})

function request(authorization: string | undefined): FastifyRequest {
  return { headers: { authorization } } as FastifyRequest
}
