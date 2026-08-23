import { describe, expect, it } from 'vitest'

import { ApiConfigurationError, readApiConfig } from '../src/config.js'

const validEnvironment: NodeJS.ProcessEnv = {
  API_HOST: '0.0.0.0',
  API_PORT: '8080',
  DATABASE_POOL_SIZE: '12',
  DATABASE_URL: 'postgresql://user:password@database.example.test:5432/uploads?sslmode=require',
  JWT_AUDIENCE: 'resumable-upload-api',
  JWT_ISSUER: 'https://identity.example.test/',
  JWT_JWKS_URL: 'https://identity.example.test/.well-known/jwks.json',
  UPLOAD_CLEANUP_BATCH_SIZE: '80',
  UPLOAD_CLEANUP_CLAIM_MS: '120000',
  UPLOAD_CLEANUP_CONCURRENCY: '8',
  UPLOAD_CLEANUP_INTERVAL_MS: '30000',
  UPLOAD_DIRECTORY: './var/demo-uploads',
}

describe('API configuration', () => {
  it('parses bounded values and resolves the storage directory', () => {
    const config = readApiConfig(validEnvironment)

    expect(config).toMatchObject({
      audience: 'resumable-upload-api',
      cleanupBatchSize: 80,
      cleanupClaimDurationMs: 120_000,
      cleanupConcurrency: 8,
      cleanupIntervalMs: 30_000,
      databasePoolSize: 12,
      host: '0.0.0.0',
      issuer: 'https://identity.example.test/',
      port: 8080,
    })
    expect(config.uploadDirectory).toMatch(/var\/demo-uploads$/u)
    expect(Object.isFrozen(config)).toBe(true)
  })

  it('applies conservative non-secret defaults', () => {
    const config = readApiConfig({
      DATABASE_URL: validEnvironment.DATABASE_URL,
      JWT_AUDIENCE: validEnvironment.JWT_AUDIENCE,
      JWT_ISSUER: validEnvironment.JWT_ISSUER,
      JWT_JWKS_URL: validEnvironment.JWT_JWKS_URL,
    })

    expect(config).toMatchObject({
      cleanupBatchSize: 50,
      cleanupClaimDurationMs: 300_000,
      cleanupConcurrency: 4,
      cleanupIntervalMs: 60_000,
      databasePoolSize: 10,
      host: '127.0.0.1',
      port: 3000,
    })
    expect(config.uploadDirectory).toMatch(/var\/uploads$/u)
  })

  it.each([
    ['missing database', { DATABASE_URL: undefined }],
    ['wrong database scheme', { DATABASE_URL: 'https://database.example.test/uploads' }],
    ['malformed database', { DATABASE_URL: 'not a database URL' }],
    ['database fragment', { DATABASE_URL: 'postgresql://localhost/uploads#secret' }],
    ['missing audience', { JWT_AUDIENCE: undefined }],
    ['padded audience', { JWT_AUDIENCE: ' audience' }],
    ['invalid issuer', { JWT_ISSUER: 'identity.example.test' }],
    ['insecure remote issuer', { JWT_ISSUER: 'http://identity.example.test/' }],
    ['credentialed JWKS URL', { JWT_JWKS_URL: 'https://user:secret@identity.example.test/jwks' }],
    ['zero port', { API_PORT: '0' }],
    ['oversized port', { API_PORT: '65536' }],
    ['non-canonical pool size', { DATABASE_POOL_SIZE: '01' }],
    ['oversized pool', { DATABASE_POOL_SIZE: '101' }],
    ['zero cleanup batch size', { UPLOAD_CLEANUP_BATCH_SIZE: '0' }],
    ['oversized cleanup batch', { UPLOAD_CLEANUP_BATCH_SIZE: '1001' }],
    ['oversized cleanup claim', { UPLOAD_CLEANUP_CLAIM_MS: '3600001' }],
    ['oversized cleanup concurrency', { UPLOAD_CLEANUP_CONCURRENCY: '33' }],
    ['invalid cleanup interval', { UPLOAD_CLEANUP_INTERVAL_MS: '1.5' }],
    ['NUL in directory', { UPLOAD_DIRECTORY: 'var/\0uploads' }],
  ] as const)('rejects %s', (_name, override) => {
    expect(() => readApiConfig({ ...validEnvironment, ...override })).toThrow(ApiConfigurationError)
  })

  it('permits HTTP identity endpoints only for local development', () => {
    const config = readApiConfig({
      ...validEnvironment,
      JWT_ISSUER: 'http://localhost:4444/',
      JWT_JWKS_URL: 'http://127.0.0.1:4444/jwks.json',
    })

    expect(config.issuer).toBe('http://localhost:4444/')
  })
})
