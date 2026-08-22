import { createHash } from 'node:crypto'

import { createRemoteJWKSet, decodeJwt, jwtVerify } from 'jose'
import { afterEach, describe, expect, it } from 'vitest'

import { appOrigin, audience, clientId, identityOrigin, redirectUri } from '../src/environment.js'
import { startTestIdentityProvider, type TestIdentityProvider } from '../src/identity-provider.js'

describe('test identity provider', () => {
  let provider: TestIdentityProvider | null = null

  afterEach(async () => {
    await provider?.close()
    provider = null
  })

  it('enforces PKCE and issues verifiable owner tokens for the browser flow', async () => {
    provider = await startTestIdentityProvider()
    const discovery = await fetch(`${identityOrigin}.well-known/openid-configuration`)
    await expect(discovery.json()).resolves.toMatchObject({
      code_challenge_methods_supported: ['S256'],
      issuer: identityOrigin,
      token_endpoint_auth_methods_supported: ['none'],
    })

    const verifier = 'e2e-code-verifier-with-more-than-forty-three-characters'
    const authorize = new URL(`${identityOrigin}authorize`)
    authorize.search = new URLSearchParams({
      client_id: clientId,
      code_challenge: sha256Base64Url(verifier),
      code_challenge_method: 'S256',
      nonce: 'test-nonce',
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid profile',
      state: 'test-state',
    }).toString()
    const authorization = await fetch(authorize, {
      headers: { Cookie: 'e2e-subject=user-bob' },
      redirect: 'manual',
    })
    expect(authorization.status).toBe(302)
    const callback = new URL(requireHeader(authorization, 'location'))
    expect(callback.origin + callback.pathname).toBe(redirectUri)
    expect(callback.searchParams.get('state')).toBe('test-state')
    const code = callback.searchParams.get('code')
    if (!code) throw new Error('Authorization response did not contain a code')

    const token = await fetch(`${identityOrigin}token`, {
      body: new URLSearchParams({
        client_id: clientId,
        code,
        code_verifier: verifier,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
      headers: { Origin: appOrigin },
      method: 'POST',
    })
    expect(token.status).toBe(200)
    expect(token.headers.get('access-control-allow-origin')).toBe(appOrigin)
    const tokenBody = (await token.json()) as {
      readonly access_token: string
      readonly id_token: string
    }
    const jwks = createRemoteJWKSet(new URL(`${identityOrigin}jwks.json`))
    await expect(
      jwtVerify(tokenBody.access_token, jwks, { audience, issuer: identityOrigin }),
    ).resolves.toMatchObject({ payload: { sub: 'user-bob' } })
    await expect(
      jwtVerify(tokenBody.id_token, jwks, { audience: clientId, issuer: identityOrigin }),
    ).resolves.toMatchObject({ payload: { name: 'Bob', nonce: 'test-nonce', sub: 'user-bob' } })
    expect(decodeJwt(tokenBody.access_token).sub).toBe('user-bob')

    const userInfo = await fetch(`${identityOrigin}userinfo`, {
      headers: { Authorization: `Bearer ${tokenBody.access_token}`, Origin: appOrigin },
    })
    await expect(userInfo.json()).resolves.toEqual({ name: 'Bob', sub: 'user-bob' })

    const reusedCode = await fetch(`${identityOrigin}token`, {
      body: new URLSearchParams({
        client_id: clientId,
        code,
        code_verifier: verifier,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
      method: 'POST',
    })
    await expect(reusedCode.json()).resolves.toEqual({ error: 'invalid_grant' })

    const logout = await fetch(
      `${identityOrigin}logout?post_logout_redirect_uri=${encodeURIComponent(`${appOrigin}/`)}`,
      { redirect: 'manual' },
    )
    expect(logout.status).toBe(302)
    expect(requireHeader(logout, 'location')).toBe(`${appOrigin}/`)
  })
})

function sha256Base64Url(value: string): string {
  return createHash('sha256').update(value).digest('base64url')
}

function requireHeader(response: Response, name: string): string {
  const value = response.headers.get(name)
  if (!value) throw new Error(`Response did not contain ${name}`)
  return value
}
