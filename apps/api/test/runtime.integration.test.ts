import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Pool } from 'pg'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runUploadMigrations } from '@resumable-upload-kit/storage-postgres-filesystem'

import { AccessTokenRejectedError, type AccessTokenVerifier } from '../src/auth.js'
import type { ApiConfig } from '../src/config.js'
import { createProductionApi } from '../src/runtime.js'

const databaseUrl = process.env.TEST_DATABASE_URL

if (!databaseUrl) {
  throw new Error('TEST_DATABASE_URL is required for PostgreSQL integration tests')
}

describe('authenticated API restart', () => {
  const roots: string[] = []
  const pools: Pool[] = []
  const apps: FastifyInstance[] = []

  beforeEach(async () => {
    const pool = new Pool({ connectionString: databaseUrl })
    pools.push(pool)
    await runUploadMigrations(pool)
    await pool.query('TRUNCATE resumable_uploads')
  })

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()))
    await Promise.all(pools.splice(0).map((pool) => pool.end()))
    await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
  })

  it('retains an owned upload across an application and pool restart', async () => {
    const uploadDirectory = await mkdtemp(join(tmpdir(), 'resumable-upload-api-'))
    roots.push(uploadDirectory)
    const config: ApiConfig = {
      audience: 'resumable-upload-api',
      databasePoolSize: 2,
      databaseUrl,
      host: '127.0.0.1',
      issuer: 'https://identity.example.test/',
      jwksUrl: 'https://identity.example.test/jwks.json',
      port: 3000,
      uploadDirectory,
    }
    const verifier = integrationVerifier()
    const first = await createProductionApi(config, {
      accessTokenVerifier: verifier,
      logger: false,
    })
    apps.push(first)
    const created = await first.inject({
      headers: uploadHeaders('alice', { 'upload-length': '5' }),
      method: 'POST',
      url: '/uploads',
    })
    const location = created.headers.location
    expect(created.statusCode).toBe(201)
    expect(location).toMatch(/^\/uploads\/[0-9a-f-]+$/u)
    await first.close()
    apps.splice(apps.indexOf(first), 1)

    const restarted = await createProductionApi(config, {
      accessTokenVerifier: verifier,
      logger: false,
    })
    apps.push(restarted)
    const recovered = await restarted.inject({
      headers: uploadHeaders('alice'),
      method: 'HEAD',
      url: location ?? '/missing',
    })
    const foreign = await restarted.inject({
      headers: uploadHeaders('bob'),
      method: 'HEAD',
      url: location ?? '/missing',
    })

    expect(recovered.statusCode).toBe(200)
    expect(recovered.headers).toMatchObject({ 'upload-length': '5', 'upload-offset': '0' })
    expect(foreign.statusCode).toBe(404)
  })
})

function integrationVerifier(): AccessTokenVerifier {
  return {
    async verify(token: string): Promise<string> {
      if (token === 'alice' || token === 'bob') {
        return `user-${token}`
      }

      throw new AccessTokenRejectedError('invalid integration token')
    },
  }
}

function uploadHeaders(
  token: string,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'tus-resumable': '1.0.0', ...extra }
}
