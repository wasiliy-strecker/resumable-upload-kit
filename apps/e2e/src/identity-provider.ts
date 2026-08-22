import { createHash, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import { SignJWT, exportJWK, generateKeyPair, type CryptoKey, type JWK } from 'jose'

import {
  appOrigin,
  audience,
  clientId,
  identityOrigin,
  identityPort,
  redirectUri,
} from './environment.js'

interface AuthorizationGrant {
  readonly codeChallenge: string
  readonly expiresAt: number
  readonly nonce: string
  readonly subject: Subject
}

interface Identity {
  readonly displayName: string
  readonly subject: Subject
}

type Subject = 'user-alice' | 'user-bob'

export interface TestIdentityProvider {
  close(): Promise<void>
}

const keyId = 'e2e-signing-key'
const identities: Readonly<Record<Subject, Identity>> = Object.freeze({
  'user-alice': { displayName: 'Alice', subject: 'user-alice' },
  'user-bob': { displayName: 'Bob', subject: 'user-bob' },
})

export async function startTestIdentityProvider(): Promise<TestIdentityProvider> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true })
  const publicJwk = await signingJwk(publicKey)
  const authorizationCodes = new Map<string, AuthorizationGrant>()
  const accessTokens = new Map<string, Identity>()
  const server = createServer((request, response) => {
    void handleRequest({
      accessTokens,
      authorizationCodes,
      privateKey,
      publicJwk,
      request,
      response,
    }).catch(() => oauthError(response, 500, 'server_error'))
  })

  await listen(server, identityPort)

  return {
    async close(): Promise<void> {
      server.closeIdleConnections()
      await close(server)
    },
  }
}

async function handleRequest(options: {
  readonly accessTokens: Map<string, Identity>
  readonly authorizationCodes: Map<string, AuthorizationGrant>
  readonly privateKey: CryptoKey
  readonly publicJwk: JWK
  readonly request: IncomingMessage
  readonly response: ServerResponse
}): Promise<void> {
  const { request, response } = options
  const url = new URL(request.url ?? '/', identityOrigin)

  if (request.method === 'OPTIONS') {
    cors(response)
    response.writeHead(204).end()
    return
  }

  if (request.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
    json(response, 200, {
      authorization_endpoint: `${identityOrigin}authorize`,
      claims_supported: ['sub', 'name'],
      code_challenge_methods_supported: ['S256'],
      end_session_endpoint: `${identityOrigin}logout`,
      id_token_signing_alg_values_supported: ['RS256'],
      issuer: identityOrigin,
      jwks_uri: `${identityOrigin}jwks.json`,
      response_modes_supported: ['query'],
      response_types_supported: ['code'],
      scopes_supported: ['openid', 'profile'],
      subject_types_supported: ['public'],
      token_endpoint: `${identityOrigin}token`,
      token_endpoint_auth_methods_supported: ['none'],
      userinfo_endpoint: `${identityOrigin}userinfo`,
    })
    return
  }

  if (request.method === 'GET' && url.pathname === '/jwks.json') {
    json(response, 200, { keys: [options.publicJwk] })
    return
  }

  if (request.method === 'GET' && url.pathname === '/authorize') {
    authorize(url, request, response, options.authorizationCodes)
    return
  }

  if (request.method === 'POST' && url.pathname === '/token') {
    await exchangeCode(request, response, options)
    return
  }

  if (request.method === 'GET' && url.pathname === '/userinfo') {
    userInfo(request, response, options.accessTokens)
    return
  }

  if (request.method === 'GET' && url.pathname === '/logout') {
    logout(url, response)
    return
  }

  oauthError(response, 404, 'not_found')
}

function authorize(
  url: URL,
  request: IncomingMessage,
  response: ServerResponse,
  authorizationCodes: Map<string, AuthorizationGrant>,
): void {
  const state = url.searchParams.get('state')
  const nonce = url.searchParams.get('nonce')
  const codeChallenge = url.searchParams.get('code_challenge')

  if (
    url.searchParams.get('client_id') !== clientId ||
    url.searchParams.get('redirect_uri') !== redirectUri ||
    url.searchParams.get('response_type') !== 'code' ||
    url.searchParams.get('code_challenge_method') !== 'S256' ||
    !url.searchParams.get('scope')?.split(' ').includes('openid') ||
    !state ||
    !nonce ||
    !codeChallenge
  ) {
    oauthError(response, 400, 'invalid_request')
    return
  }

  const code = randomUUID()
  authorizationCodes.set(code, {
    codeChallenge,
    expiresAt: Date.now() + 60_000,
    nonce,
    subject: requestedSubject(request),
  })
  const callback = new URL(redirectUri)
  callback.searchParams.set('code', code)
  callback.searchParams.set('state', state)
  response.writeHead(302, { 'Cache-Control': 'no-store', Location: callback.href }).end()
}

async function exchangeCode(
  request: IncomingMessage,
  response: ServerResponse,
  options: {
    readonly accessTokens: Map<string, Identity>
    readonly authorizationCodes: Map<string, AuthorizationGrant>
    readonly privateKey: CryptoKey
  },
): Promise<void> {
  const body = new URLSearchParams(await readBody(request))
  const code = body.get('code')
  const verifier = body.get('code_verifier')
  const grant = code ? options.authorizationCodes.get(code) : undefined

  if (code) options.authorizationCodes.delete(code)

  if (
    body.get('grant_type') !== 'authorization_code' ||
    body.get('client_id') !== clientId ||
    body.get('redirect_uri') !== redirectUri ||
    !grant ||
    grant.expiresAt < Date.now() ||
    !verifier ||
    sha256Base64Url(verifier) !== grant.codeChallenge
  ) {
    oauthError(response, 400, 'invalid_grant')
    return
  }

  const identity = identities[grant.subject]
  const now = Math.floor(Date.now() / 1_000)
  const accessToken = await new SignJWT({ scope: 'openid profile' })
    .setProtectedHeader({ alg: 'RS256', kid: keyId, typ: 'JWT' })
    .setIssuer(identityOrigin)
    .setAudience(audience)
    .setSubject(identity.subject)
    .setIssuedAt(now)
    .setExpirationTime(now + 600)
    .sign(options.privateKey)
  const idToken = await new SignJWT({ name: identity.displayName, nonce: grant.nonce })
    .setProtectedHeader({ alg: 'RS256', kid: keyId, typ: 'JWT' })
    .setIssuer(identityOrigin)
    .setAudience(clientId)
    .setSubject(identity.subject)
    .setIssuedAt(now)
    .setExpirationTime(now + 600)
    .sign(options.privateKey)
  options.accessTokens.set(accessToken, identity)

  json(
    response,
    200,
    {
      access_token: accessToken,
      expires_in: 600,
      id_token: idToken,
      scope: 'openid profile',
      token_type: 'Bearer',
    },
    { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
  )
}

function userInfo(
  request: IncomingMessage,
  response: ServerResponse,
  accessTokens: ReadonlyMap<string, Identity>,
): void {
  const authorization = request.headers.authorization
  const identity = authorization?.startsWith('Bearer ')
    ? accessTokens.get(authorization.slice('Bearer '.length))
    : undefined

  if (!identity) {
    oauthError(response, 401, 'invalid_token')
    return
  }

  json(response, 200, { name: identity.displayName, sub: identity.subject })
}

function logout(url: URL, response: ServerResponse): void {
  const destination = url.searchParams.get('post_logout_redirect_uri')

  if (destination !== `${appOrigin}/`) {
    oauthError(response, 400, 'invalid_request')
    return
  }

  const redirect = new URL(destination)
  const state = url.searchParams.get('state')
  if (state) redirect.searchParams.set('state', state)
  response.writeHead(302, { 'Cache-Control': 'no-store', Location: redirect.href }).end()
}

function requestedSubject(request: IncomingMessage): Subject {
  const cookie = request.headers.cookie
    ?.split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith('e2e-subject='))
    ?.slice('e2e-subject='.length)
  return cookie === 'user-bob' ? 'user-bob' : 'user-alice'
}

async function signingJwk(publicKey: CryptoKey): Promise<JWK> {
  return { ...(await exportJWK(publicKey)), alg: 'RS256', kid: keyId, use: 'sig' }
}

function sha256Base64Url(value: string): string {
  return createHash('sha256').update(value).digest('base64url')
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Uint8Array[] = []
  let size = 0

  for await (const chunk of request) {
    const value: unknown = chunk
    if (typeof value !== 'string' && !(value instanceof Uint8Array)) {
      throw new TypeError('OIDC test request contains an unsupported body chunk')
    }
    const buffer = Buffer.from(value)
    size += buffer.length
    if (size > 32_768) throw new Error('OIDC test request is too large')
    chunks.push(buffer)
  }

  return Buffer.concat(chunks).toString('utf8')
}

function cors(response: ServerResponse): void {
  response.setHeader('Access-Control-Allow-Headers', 'authorization, content-type')
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  response.setHeader('Access-Control-Allow-Origin', appOrigin)
}

function json(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  cors(response)
  response.writeHead(status, { 'Content-Type': 'application/json', ...headers })
  response.end(JSON.stringify(body))
}

function oauthError(response: ServerResponse, status: number, error: string): void {
  if (response.headersSent) return
  json(response, status, { error })
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}
