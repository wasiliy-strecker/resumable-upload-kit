export interface WebAppConfig {
  readonly clientId: string
  readonly oidcAuthority: string
  readonly postLogoutRedirectUri: string
  readonly redirectUri: string
  readonly scope: string
  readonly uploadEndpoint: string
}

export class WebConfigurationError extends Error {
  public override readonly name = 'WebConfigurationError'
}

export function readWebAppConfig(
  environment: Readonly<Record<string, string | undefined>>,
  origin: string,
): WebAppConfig {
  const applicationOrigin = originUrl(origin)
  const scope = boundedText(environment.VITE_OIDC_SCOPE ?? 'openid profile', 'VITE_OIDC_SCOPE', 500)

  if (!scope.split(/\s+/u).includes('openid')) {
    throw new WebConfigurationError('VITE_OIDC_SCOPE must include openid')
  }

  return Object.freeze({
    clientId: boundedText(environment.VITE_OIDC_CLIENT_ID, 'VITE_OIDC_CLIENT_ID', 200),
    oidcAuthority: identityUrl(environment.VITE_OIDC_AUTHORITY, 'VITE_OIDC_AUTHORITY'),
    postLogoutRedirectUri: new URL('/', applicationOrigin).href,
    redirectUri: new URL('/auth/callback', applicationOrigin).href,
    scope,
    uploadEndpoint: uploadEndpoint(environment.VITE_UPLOAD_ENDPOINT ?? '/uploads'),
  })
}

function boundedText(value: string | undefined, name: string, maximumLength: number): string {
  if (
    value === undefined ||
    value.length === 0 ||
    value.trim() !== value ||
    value.length > maximumLength ||
    value.includes('\0')
  ) {
    throw new WebConfigurationError(`${name} is invalid`)
  }

  return value
}

function identityUrl(value: string | undefined, name: string): string {
  const raw = boundedText(value, name, 2_048)
  let parsed: URL

  try {
    parsed = new URL(raw)
  } catch (error) {
    throw new WebConfigurationError(`${name} must be a valid URL`, { cause: error })
  }

  if (
    (parsed.protocol !== 'https:' && !isLoopbackHttp(parsed)) ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new WebConfigurationError(`${name} must use HTTPS or loopback HTTP`)
  }

  return raw
}

function originUrl(value: string): URL {
  try {
    const parsed = new URL(value)

    if ((parsed.protocol === 'https:' || isLoopbackHttp(parsed)) && parsed.origin === value) {
      return parsed
    }
  } catch {
    // The stable public error below intentionally does not echo configuration values.
  }

  throw new WebConfigurationError('Application origin is invalid')
}

function uploadEndpoint(value: string): string {
  if (!/^\/[a-z0-9/_-]*[a-z0-9_-]$/iu.test(value) || value.includes('//')) {
    throw new WebConfigurationError('VITE_UPLOAD_ENDPOINT must be a same-origin path')
  }

  return value
}

function isLoopbackHttp(url: URL): boolean {
  return (
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')
  )
}
