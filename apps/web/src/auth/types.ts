export interface AuthUser {
  readonly accessToken: string
  readonly displayName: string
  readonly subject: string
}

export interface AuthClient {
  completeSignIn(): Promise<AuthUser | null>
  restoreUser(): Promise<AuthUser | null>
  signIn(): Promise<void>
  signOut(): Promise<void>
  subscribe(listener: (user: AuthUser | null) => void): () => void
}

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous' | 'error'
