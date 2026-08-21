import { describe, expect, it } from 'vitest'

import { readWebAppConfig, WebConfigurationError } from '../src/config.js'

const validEnvironment = {
  VITE_OIDC_AUTHORITY: 'https://identity.example.test/',
  VITE_OIDC_CLIENT_ID: 'resumable-upload-web',
  VITE_OIDC_SCOPE: 'openid profile email',
  VITE_UPLOAD_ENDPOINT: '/uploads',
}

describe('web application configuration', () => {
  it('derives callback locations and accepts a same-origin upload endpoint', () => {
    const config = readWebAppConfig(validEnvironment, 'https://uploads.example.test')

    expect(config).toEqual({
      clientId: 'resumable-upload-web',
      oidcAuthority: 'https://identity.example.test/',
      postLogoutRedirectUri: 'https://uploads.example.test/',
      redirectUri: 'https://uploads.example.test/auth/callback',
      scope: 'openid profile email',
      uploadEndpoint: '/uploads',
    })
    expect(Object.isFrozen(config)).toBe(true)
  })

  it('uses minimal safe defaults and permits a loopback identity provider', () => {
    const config = readWebAppConfig(
      {
        VITE_OIDC_AUTHORITY: 'http://localhost:4444/',
        VITE_OIDC_CLIENT_ID: 'local-web',
      },
      'http://127.0.0.1:5173',
    )

    expect(config).toMatchObject({ scope: 'openid profile', uploadEndpoint: '/uploads' })
  })

  it.each([
    ['missing authority', { VITE_OIDC_AUTHORITY: undefined }],
    ['remote HTTP authority', { VITE_OIDC_AUTHORITY: 'http://identity.example.test/' }],
    [
      'credentialed authority',
      { VITE_OIDC_AUTHORITY: 'https://user:secret@identity.example.test/' },
    ],
    ['fragmented authority', { VITE_OIDC_AUTHORITY: 'https://identity.example.test/#keys' }],
    ['missing client', { VITE_OIDC_CLIENT_ID: undefined }],
    ['padded client', { VITE_OIDC_CLIENT_ID: ' client' }],
    ['missing openid scope', { VITE_OIDC_SCOPE: 'profile email' }],
    ['absolute endpoint', { VITE_UPLOAD_ENDPOINT: 'https://api.example.test/uploads' }],
    ['double slash endpoint', { VITE_UPLOAD_ENDPOINT: '/api//uploads' }],
  ] as const)('rejects %s', (_name, override) => {
    expect(() =>
      readWebAppConfig({ ...validEnvironment, ...override }, 'https://uploads.example.test'),
    ).toThrow(WebConfigurationError)
  })

  it.each([
    'uploads.example.test',
    'ftp://uploads.example.test',
    'https://uploads.example.test/path',
  ])('rejects an invalid application origin', (origin) => {
    expect(() => readWebAppConfig(validEnvironment, origin)).toThrow('Application origin')
  })
})
