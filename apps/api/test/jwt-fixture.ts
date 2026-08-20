import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type CryptoKey,
  type JWTVerifyGetKey,
} from 'jose'

import { createAccessTokenVerifier, type AccessTokenVerifier } from '../src/auth.js'

const audience = 'resumable-upload-api'
const issuer = 'https://identity.example.test/'
const keyId = 'integration-key'

export interface JwtFixture {
  readonly audience: string
  readonly issuer: string
  readonly jwks: JWTVerifyGetKey
  readonly sign: (options?: SignTokenOptions) => Promise<string>
  readonly verifier: AccessTokenVerifier
}

export interface SignTokenOptions {
  readonly audience?: string
  readonly expiresAt?: number
  readonly issuedAt?: number
  readonly subject?: string
}

export async function createJwtFixture(): Promise<JwtFixture> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true })
  const publicJwk = await exportJWK(publicKey)
  const jwks = createLocalJWKSet({
    keys: [{ ...publicJwk, alg: 'RS256', kid: keyId, use: 'sig' }],
  })
  const sign = (options: SignTokenOptions = {}): Promise<string> => signToken(privateKey, options)

  return {
    audience,
    issuer,
    jwks,
    sign,
    verifier: createAccessTokenVerifier({
      algorithms: ['RS256'],
      audience,
      issuer,
      jwks,
      jwksUrl: 'https://identity.example.test/jwks.json',
    }),
  }
}

async function signToken(privateKey: CryptoKey, options: SignTokenOptions): Promise<string> {
  const now = Math.floor(Date.now() / 1_000)
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: keyId, typ: 'JWT' })
    .setIssuer(issuer)
    .setAudience(options.audience ?? audience)
    .setSubject(options.subject ?? 'user-alice')
    .setIssuedAt(options.issuedAt ?? now)
    .setExpirationTime(options.expiresAt ?? now + 300)
    .sign(privateKey)
}
