import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

import type { AuthClient, AuthStatus, AuthUser } from './types.js'

export interface AuthContextValue {
  readonly error: Error | null
  readonly getAccessToken: () => string | null
  readonly signIn: () => Promise<void>
  readonly signOut: () => Promise<void>
  readonly status: AuthStatus
  readonly user: AuthUser | null
}

interface AuthProviderProps {
  readonly callbackPath?: string
  readonly children: ReactNode
  readonly client: AuthClient
  readonly currentPath?: string
  readonly onCallbackComplete?: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({
  callbackPath = '/auth/callback',
  children,
  client,
  currentPath = window.location.pathname,
  onCallbackComplete = replaceCallbackLocation,
}: AuthProviderProps): ReactNode {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [status, setStatus] = useState<AuthStatus>('loading')
  const [error, setError] = useState<Error | null>(null)
  const userRef = useRef<AuthUser | null>(null)
  const bootstrapRef = useRef<{
    readonly client: AuthClient
    readonly promise: Promise<AuthUser | null>
  } | null>(null)

  const applyUser = useCallback((nextUser: AuthUser | null): void => {
    userRef.current = nextUser
    setUser(nextUser)
    setError(null)
    setStatus(nextUser ? 'authenticated' : 'anonymous')
  }, [])

  useEffect(() => client.subscribe(applyUser), [applyUser, client])

  useEffect(() => {
    let active = true

    if (bootstrapRef.current?.client !== client) {
      const callback = currentPath === callbackPath
      const promise = (callback ? client.completeSignIn() : client.restoreUser()).then(
        (nextUser) => {
          if (callback) onCallbackComplete()
          return nextUser
        },
      )
      bootstrapRef.current = { client, promise }
    }

    void bootstrapRef.current.promise.then(
      (nextUser) => {
        if (active) applyUser(nextUser)
      },
      (reason: unknown) => {
        if (active) {
          setError(normalizeError(reason))
          setStatus('error')
        }
      },
    )

    return () => {
      active = false
    }
  }, [applyUser, callbackPath, client, currentPath, onCallbackComplete])

  const signIn = useCallback(async (): Promise<void> => client.signIn(), [client])
  const signOut = useCallback(async (): Promise<void> => client.signOut(), [client])
  const getAccessToken = useCallback(() => userRef.current?.accessToken ?? null, [])
  const value = useMemo(
    () => ({ error, getAccessToken, signIn, signOut, status, user }),
    [error, getAccessToken, signIn, signOut, status, user],
  )

  return <AuthContext value={value}>{children}</AuthContext>
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext)

  if (value === null) {
    throw new Error('useAuth must be used within AuthProvider')
  }

  return value
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Authentication failed', { cause: error })
}

function replaceCallbackLocation(): void {
  window.history.replaceState(null, '', '/')
}
