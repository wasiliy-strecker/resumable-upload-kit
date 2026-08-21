// @vitest-environment jsdom

import 'fake-indexeddb/auto'

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { App } from '../src/app.js'
import type { AuthClient, AuthUser } from '../src/auth/types.js'
import type { WebAppConfig } from '../src/config.js'

const config: WebAppConfig = {
  clientId: 'web-client',
  oidcAuthority: 'https://identity.example.test/',
  postLogoutRedirectUri: 'http://localhost/',
  redirectUri: 'http://localhost/auth/callback',
  scope: 'openid profile',
  uploadEndpoint: '/uploads',
}
const alice: AuthUser = { accessToken: 'token', displayName: 'Alice', subject: 'alice' }

describe('web application shell', () => {
  afterEach(() => {
    cleanup()
    indexedDB.deleteDatabase('resumable-upload-kit:alice')
  })

  it('presents PKCE sign-in and delegates it explicitly', async () => {
    const user = userEvent.setup()
    const client = authClient(null)
    render(<App authClient={client.value} config={config} />)

    const button = await screen.findByRole('button', { name: /Sign in with/i })
    expect(screen.getByText(/Authorization Code with PKCE/)).toBeTruthy()
    await user.click(button)
    expect(client.signIn).toHaveBeenCalledOnce()
  })

  it('opens an owner-scoped upload workspace and delegates sign-out', async () => {
    const user = userEvent.setup()
    const client = authClient(alice)
    render(<App authClient={client.value} config={config} />)

    await screen.findByText('Signed in as')
    expect(screen.getByText('Alice')).toBeTruthy()
    expect(await screen.findByText('No interrupted uploads on this browser.')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(client.signOut).toHaveBeenCalledOnce()
  })

  it('shows authentication and logout failures without losing the workspace', async () => {
    const failedRestore = authClient(null, new Error('OIDC discovery failed'))
    const first = render(<App authClient={failedRestore.value} config={config} />)
    expect(await screen.findByText('We could not restore your session')).toBeTruthy()
    first.unmount()

    const failedLogout = authClient(alice)
    failedLogout.signOut.mockRejectedValueOnce(new Error('Logout endpoint unavailable'))
    render(<App authClient={failedLogout.value} config={config} />)
    await screen.findByText('Signed in as')
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Logout endpoint unavailable')
  })
})

function authClient(restored: AuthUser | null, failure?: Error) {
  const restoreUser = vi.fn(async () => {
    if (failure) throw failure
    return restored
  })
  const signIn = vi.fn(async () => undefined)
  const signOut = vi.fn(async () => undefined)
  const value: AuthClient = {
    completeSignIn: vi.fn(async () => restored),
    restoreUser,
    signIn,
    signOut,
    subscribe: () => () => undefined,
  }
  return { restoreUser, signIn, signOut, value }
}
