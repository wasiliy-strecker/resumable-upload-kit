import {
  UserManager,
  WebStorageStateStore,
  type User,
  type UserManagerSettings,
} from 'oidc-client-ts'

import type { WebAppConfig } from '../config.js'
import type { AuthClient, AuthUser } from './types.js'

export function createOidcAuthClient(
  config: WebAppConfig,
  storage: Storage = window.sessionStorage,
  createManager: (settings: UserManagerSettings) => OidcManager = (settings) =>
    new UserManager(settings),
): AuthClient {
  const manager = createManager({
    authority: config.oidcAuthority,
    automaticSilentRenew: true,
    client_id: config.clientId,
    monitorSession: false,
    post_logout_redirect_uri: config.postLogoutRedirectUri,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: config.scope,
    stateStore: new WebStorageStateStore({ store: storage }),
    userStore: new WebStorageStateStore({ store: storage }),
  })

  return {
    async completeSignIn(): Promise<AuthUser | null> {
      return toAuthUser(await manager.signinRedirectCallback())
    },
    async restoreUser(): Promise<AuthUser | null> {
      return toAuthUser(await manager.getUser())
    },
    async signIn(): Promise<void> {
      await manager.signinRedirect()
    },
    async signOut(): Promise<void> {
      await manager.signoutRedirect()
    },
    subscribe(listener): () => void {
      const loaded = (user: User): void => listener(toAuthUser(user))
      const unloaded = (): void => listener(null)
      manager.events.addUserLoaded(loaded)
      manager.events.addUserUnloaded(unloaded)
      manager.events.addAccessTokenExpired(unloaded)

      return () => {
        manager.events.removeUserLoaded(loaded)
        manager.events.removeUserUnloaded(unloaded)
        manager.events.removeAccessTokenExpired(unloaded)
      }
    },
  }
}

interface OidcManager {
  readonly events: Pick<
    UserManager['events'],
    | 'addAccessTokenExpired'
    | 'addUserLoaded'
    | 'addUserUnloaded'
    | 'removeAccessTokenExpired'
    | 'removeUserLoaded'
    | 'removeUserUnloaded'
  >
  getUser(): Promise<User | null>
  signinRedirect(): Promise<void>
  signinRedirectCallback(): Promise<User>
  signoutRedirect(): Promise<void>
}

function toAuthUser(user: User | null): AuthUser | null {
  const subject = user?.profile.sub

  if (!user || user.expired || !user.access_token || !subject) {
    return null
  }

  return Object.freeze({
    accessToken: user.access_token,
    displayName: displayName(user, subject),
    subject,
  })
}

function displayName(user: User, fallback: string): string {
  const candidate = [user.profile.name, user.profile.preferred_username, fallback].find(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  )
  return candidate?.trim() ?? fallback
}
