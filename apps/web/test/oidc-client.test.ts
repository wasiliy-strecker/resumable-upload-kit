// @vitest-environment jsdom

import type { User, UserManagerSettings } from 'oidc-client-ts'
import { describe, expect, it, vi } from 'vitest'

import { createOidcAuthClient } from '../src/auth/oidc-client.js'
import type { WebAppConfig } from '../src/config.js'

const config: WebAppConfig = {
  clientId: 'web-client',
  oidcAuthority: 'https://identity.example.test/',
  postLogoutRedirectUri: 'https://uploads.example.test/',
  redirectUri: 'https://uploads.example.test/auth/callback',
  scope: 'openid profile',
  uploadEndpoint: '/uploads',
}

describe('OIDC client adapter', () => {
  it('configures PKCE redirect flow and maps restored and callback users', async () => {
    const harness = managerHarness(user({ name: 'Alice', sub: 'alice' }))
    let settings: UserManagerSettings | null = null
    const client = createOidcAuthClient(config, window.sessionStorage, (nextSettings) => {
      settings = nextSettings
      return harness.manager
    })

    await expect(client.restoreUser()).resolves.toMatchObject({
      accessToken: 'access-token',
      displayName: 'Alice',
      subject: 'alice',
    })
    await expect(client.completeSignIn()).resolves.toMatchObject({ subject: 'alice' })
    await client.signIn()
    await client.signOut()

    expect(settings).toMatchObject({
      authority: config.oidcAuthority,
      automaticSilentRenew: true,
      client_id: config.clientId,
      monitorSession: false,
      response_type: 'code',
      scope: config.scope,
    })
    expect(harness.signinRedirect).toHaveBeenCalledOnce()
    expect(harness.signoutRedirect).toHaveBeenCalledOnce()
  })

  it('rejects expired or incomplete users and falls back to a stable display name', async () => {
    const expired = managerHarness(user({ expired: true }))
    const expiredClient = createOidcAuthClient(config, window.sessionStorage, () => expired.manager)
    await expect(expiredClient.restoreUser()).resolves.toBeNull()

    const incomplete = managerHarness(user({ access_token: '', sub: '' }))
    const incompleteClient = createOidcAuthClient(
      config,
      window.sessionStorage,
      () => incomplete.manager,
    )
    await expect(incompleteClient.restoreUser()).resolves.toBeNull()

    const fallback = managerHarness(
      user({ name: '', preferred_username: 'alice-handle', sub: 'alice' }),
    )
    const fallbackClient = createOidcAuthClient(
      config,
      window.sessionStorage,
      () => fallback.manager,
    )
    await expect(fallbackClient.restoreUser()).resolves.toMatchObject({
      displayName: 'alice-handle',
    })
  })

  it('forwards user lifecycle events and removes every listener', () => {
    const harness = managerHarness(user())
    const client = createOidcAuthClient(config, window.sessionStorage, () => harness.manager)
    const listener = vi.fn()
    const unsubscribe = client.subscribe(listener)

    harness.loaded?.(user({ sub: 'updated' }))
    harness.unloaded?.()
    harness.expired?.()
    expect(listener).toHaveBeenNthCalledWith(1, expect.objectContaining({ subject: 'updated' }))
    expect(listener).toHaveBeenNthCalledWith(2, null)
    expect(listener).toHaveBeenNthCalledWith(3, null)

    unsubscribe()
    expect(harness.removeUserLoaded).toHaveBeenCalledWith(harness.loaded)
    expect(harness.removeUserUnloaded).toHaveBeenCalledWith(harness.unloaded)
    expect(harness.removeAccessTokenExpired).toHaveBeenCalledWith(harness.expired)
  })
})

function managerHarness(currentUser: User) {
  let loaded: ((user: User) => void) | undefined
  let unloaded: (() => void) | undefined
  let expired: (() => void) | undefined
  const removeUserLoaded = vi.fn()
  const removeUserUnloaded = vi.fn()
  const removeAccessTokenExpired = vi.fn()
  const signinRedirect = vi.fn(async () => undefined)
  const signoutRedirect = vi.fn(async () => undefined)
  const manager = {
    events: {
      addAccessTokenExpired: (listener: () => void) => {
        expired = listener
        return () => undefined
      },
      addUserLoaded: (listener: (nextUser: User) => void) => {
        loaded = listener
        return () => undefined
      },
      addUserUnloaded: (listener: () => void) => {
        unloaded = listener
        return () => undefined
      },
      removeAccessTokenExpired,
      removeUserLoaded,
      removeUserUnloaded,
    },
    getUser: vi.fn(async () => currentUser),
    signinRedirect,
    signinRedirectCallback: vi.fn(async () => currentUser),
    signoutRedirect,
  }
  return {
    get expired() {
      return expired
    },
    get loaded() {
      return loaded
    },
    manager,
    removeAccessTokenExpired,
    removeUserLoaded,
    removeUserUnloaded,
    signinRedirect,
    signoutRedirect,
    get unloaded() {
      return unloaded
    },
  }
}

function user(
  override: {
    readonly access_token?: string
    readonly expired?: boolean
    readonly name?: string
    readonly preferred_username?: string
    readonly sub?: string
  } = {},
): User {
  return {
    access_token: override.access_token ?? 'access-token',
    expired: override.expired ?? false,
    profile: {
      name: override.name ?? 'Alice',
      preferred_username: override.preferred_username,
      sub: override.sub ?? 'alice',
    },
  } as User
}
