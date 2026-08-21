import { useEffect, useMemo, useState, type ReactNode } from 'react'

import type { WebAppConfig } from './config.js'
import { AuthProvider, useAuth } from './auth/auth-context.js'
import type { AuthClient, AuthUser } from './auth/types.js'
import { createUploadClientSession } from './upload/client-session.js'
import { UploadWorkspace } from './upload/upload-workspace.js'

export interface AppProps {
  readonly authClient: AuthClient
  readonly config: WebAppConfig
}

export function App({ authClient, config }: AppProps): ReactNode {
  return (
    <AuthProvider client={authClient}>
      <AppContent config={config} />
    </AuthProvider>
  )
}

function AppContent({ config }: { readonly config: WebAppConfig }): ReactNode {
  const auth = useAuth()

  if (auth.status === 'loading') {
    return <CenteredMessage eyebrow="Secure session" title="Restoring your workspace…" />
  }

  if (auth.status === 'error') {
    return (
      <CenteredMessage eyebrow="Authentication" title="We could not restore your session">
        <p>{auth.error?.message ?? 'The identity provider returned an unexpected response.'}</p>
        <button className="button button--primary" type="button" onClick={() => void auth.signIn()}>
          Sign in again
        </button>
      </CenteredMessage>
    )
  }

  if (auth.status === 'anonymous' || auth.user === null) {
    return (
      <div className="landing-shell">
        <a className="skip-link" href="#sign-in">
          Skip to sign in
        </a>
        <header className="brand-bar">
          <Brand />
        </header>
        <main className="hero" id="sign-in">
          <div className="hero__copy">
            <p className="eyebrow">Failure-aware uploads</p>
            <h1>Large files should survive small disasters.</h1>
            <p className="hero__lede">
              Upload in verified chunks, keep confirmed progress in your browser, and continue after
              a network failure or reload.
            </p>
            <button
              className="button button--primary button--large"
              type="button"
              onClick={() => void auth.signIn()}
            >
              Sign in with your identity provider
            </button>
            <p className="security-note">
              Authorization Code with PKCE · No client secret in the browser
            </p>
          </div>
          <div className="hero__diagram" aria-label="Upload recovery flow">
            <span>Choose</span>
            <i /> <span>Verify</span>
            <i /> <span>Resume</span>
          </div>
        </main>
      </div>
    )
  }

  return <AuthenticatedWorkspace config={config} user={auth.user} />
}

function AuthenticatedWorkspace({
  config,
  user,
}: {
  readonly config: WebAppConfig
  readonly user: AuthUser
}): ReactNode {
  const auth = useAuth()
  const [logoutError, setLogoutError] = useState<Error | null>(null)
  const session = useMemo(
    () =>
      createUploadClientSession({
        getAccessToken: auth.getAccessToken,
        subject: user.subject,
        uploadEndpoint: config.uploadEndpoint,
      }),
    [auth.getAccessToken, config.uploadEndpoint, user.subject],
  )

  useEffect(() => () => session.close(), [session])

  const signOut = async (): Promise<void> => {
    setLogoutError(null)
    try {
      await auth.signOut()
    } catch (error) {
      setLogoutError(
        error instanceof Error ? error : new Error('Sign out failed', { cause: error }),
      )
    }
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to uploads
      </a>
      <header className="app-header">
        <Brand />
        <div className="account">
          <span className="account__identity">
            <small>Signed in as</small>
            {user.displayName}
          </span>
          <button className="text-button" type="button" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </header>
      {logoutError ? (
        <div className="header-error" role="alert">
          {logoutError.message}
        </div>
      ) : null}
      <UploadWorkspace client={session.client} />
      <footer className="app-footer">
        Only checkpoints are stored. File bytes and access tokens never enter IndexedDB.
      </footer>
    </div>
  )
}

function Brand(): ReactNode {
  return (
    <div className="brand">
      <span className="brand__mark" aria-hidden="true">
        RU
      </span>
      <span>Resumable Upload Kit</span>
    </div>
  )
}

function CenteredMessage({
  children,
  eyebrow,
  title,
}: {
  readonly children?: ReactNode
  readonly eyebrow: string
  readonly title: string
}): ReactNode {
  return (
    <main className="centered-message">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        {children}
      </div>
    </main>
  )
}
