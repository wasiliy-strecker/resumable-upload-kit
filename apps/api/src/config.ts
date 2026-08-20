import { resolve } from 'node:path'

export interface ApiConfig {
  readonly audience: string
  readonly databasePoolSize: number
  readonly databaseUrl: string
  readonly host: string
  readonly issuer: string
  readonly jwksUrl: string
  readonly port: number
  readonly uploadDirectory: string
}

export class ApiConfigurationError extends Error {
  public override readonly name = 'ApiConfigurationError'
}

export function readApiConfig(environment: NodeJS.ProcessEnv): ApiConfig {
  return Object.freeze({
    audience: boundedText(environment.JWT_AUDIENCE, 'JWT_AUDIENCE', 200),
    databasePoolSize: positiveInteger(
      environment.DATABASE_POOL_SIZE ?? '10',
      'DATABASE_POOL_SIZE',
      {
        maximum: 100,
      },
    ),
    databaseUrl: postgresUrl(environment.DATABASE_URL),
    host: boundedText(environment.API_HOST ?? '127.0.0.1', 'API_HOST', 253),
    issuer: httpUrl(environment.JWT_ISSUER, 'JWT_ISSUER'),
    jwksUrl: httpUrl(environment.JWT_JWKS_URL, 'JWT_JWKS_URL'),
    port: positiveInteger(environment.API_PORT ?? '3000', 'API_PORT', { maximum: 65_535 }),
    uploadDirectory: resolve(
      boundedText(environment.UPLOAD_DIRECTORY ?? './var/uploads', 'UPLOAD_DIRECTORY', 4_096),
    ),
  })
}

function boundedText(value: string | undefined, name: string, maximumLength: number): string {
  if (value === undefined || value.length === 0) {
    throw new ApiConfigurationError(`${name} is required`)
  }

  if (value.trim() !== value || value.length > maximumLength || value.includes('\0')) {
    throw new ApiConfigurationError(`${name} is invalid`)
  }

  return value
}

function positiveInteger(
  value: string,
  name: string,
  options: { readonly maximum: number },
): number {
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new ApiConfigurationError(`${name} must be a positive integer`)
  }

  const parsed = Number(value)

  if (!Number.isSafeInteger(parsed) || parsed > options.maximum) {
    throw new ApiConfigurationError(`${name} must not exceed ${options.maximum}`)
  }

  return parsed
}

function postgresUrl(value: string | undefined): string {
  const raw = boundedText(value, 'DATABASE_URL', 4_096)
  let parsed: URL

  try {
    parsed = new URL(raw)
  } catch (error) {
    throw new ApiConfigurationError('DATABASE_URL must be a valid PostgreSQL URL', { cause: error })
  }

  if (
    (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') ||
    parsed.hostname.length === 0 ||
    parsed.hash.length > 0
  ) {
    throw new ApiConfigurationError('DATABASE_URL must be a valid PostgreSQL URL')
  }

  return raw
}

function httpUrl(value: string | undefined, name: string): string {
  const raw = boundedText(value, name, 2_048)
  let parsed: URL

  try {
    parsed = new URL(raw)
  } catch (error) {
    throw new ApiConfigurationError(`${name} must be a valid HTTP URL`, { cause: error })
  }

  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    (parsed.protocol === 'http:' && !isLoopbackHostname(parsed.hostname)) ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new ApiConfigurationError(`${name} must be a valid HTTP URL`)
  }

  return raw
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}
