// @vitest-environment jsdom

import { StrictMode, type ReactNode } from 'react'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AuthProvider, useAuth } from '../src/auth/auth-context.js'
import type { AuthClient, AuthUser } from '../src/auth/types.js'

const alice: AuthUser = { accessToken: 'token-a', displayName: 'Alice', subject: 'alice' }

afterEach(cleanup)

describe('AuthProvider', () => {
  it('restores a session once in StrictMode and exposes a current token getter', async () => {
    const client = fakeAuthClient({ restored: alice })
    const wrapper = ({ children }: { readonly children: ReactNode }) => (
      <StrictMode>
        <AuthProvider client={client.value} currentPath="/">
          {children}
        </AuthProvider>
      </StrictMode>
    )
    const { result } = renderHook(() => useAuth(), { wrapper })

    await waitFor(() => expect(result.current.status).toBe('authenticated'))
    expect(client.restoreUser).toHaveBeenCalledOnce()
    expect(result.current.getAccessToken()).toBe('token-a')

    act(() => client.emit({ accessToken: 'token-b', displayName: 'Alice', subject: 'alice' }))
    expect(result.current.getAccessToken()).toBe('token-b')
    act(() => client.emit(null))
    expect(result.current.status).toBe('anonymous')
    expect(result.current.getAccessToken()).toBeNull()
  })

  it('completes a callback once and replaces its history location', async () => {
    const client = fakeAuthClient({ callback: alice })
    const onCallbackComplete = vi.fn()
    const wrapper = ({ children }: { readonly children: ReactNode }) => (
      <StrictMode>
        <AuthProvider
          client={client.value}
          currentPath="/auth/callback"
          onCallbackComplete={onCallbackComplete}
        >
          {children}
        </AuthProvider>
      </StrictMode>
    )
    const { result } = renderHook(() => useAuth(), { wrapper })

    await waitFor(() => expect(result.current.user).toEqual(alice))
    expect(client.completeSignIn).toHaveBeenCalledOnce()
    expect(client.restoreUser).not.toHaveBeenCalled()
    expect(onCallbackComplete).toHaveBeenCalledOnce()
  })

  it('exposes normalized bootstrap failures and delegates explicit actions', async () => {
    const client = fakeAuthClient({ failure: 'provider failed' })
    const wrapper = ({ children }: { readonly children: ReactNode }) => (
      <AuthProvider client={client.value} currentPath="/">
        {children}
      </AuthProvider>
    )
    const { result } = renderHook(() => useAuth(), { wrapper })

    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.error).toMatchObject({
      message: 'Authentication failed',
      cause: 'provider failed',
    })
    await act(async () => {
      await result.current.signIn()
      await result.current.signOut()
    })
    expect(client.signIn).toHaveBeenCalledOnce()
    expect(client.signOut).toHaveBeenCalledOnce()
  })

  it('requires the provider boundary', () => {
    expect(() => renderHook(() => useAuth())).toThrow('AuthProvider')
  })
})

function fakeAuthClient(options: {
  readonly callback?: AuthUser | null
  readonly failure?: unknown
  readonly restored?: AuthUser | null
}) {
  let listener: ((user: AuthUser | null) => void) | null = null
  const restoreUser = vi.fn<AuthClient['restoreUser']>()
  if (options.failure !== undefined) restoreUser.mockRejectedValueOnce(options.failure)
  else restoreUser.mockResolvedValue(options.restored ?? null)
  const completeSignIn = vi.fn(async () => options.callback ?? null)
  const signIn = vi.fn(async () => undefined)
  const signOut = vi.fn(async () => undefined)
  const value: AuthClient = {
    completeSignIn,
    restoreUser,
    signIn,
    signOut,
    subscribe: (nextListener) => {
      listener = nextListener
      return () => {
        listener = null
      }
    },
  }
  return {
    completeSignIn,
    emit: (user: AuthUser | null) => listener?.(user),
    restoreUser,
    signIn,
    signOut,
    value,
  }
}
