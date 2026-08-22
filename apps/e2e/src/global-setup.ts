import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Pool } from 'pg'

import { createProductionApi } from '../../api/src/runtime.js'
import { apiPort, audience, identityOrigin } from './environment.js'
import { startTestIdentityProvider } from './identity-provider.js'

const defaultDatabaseUrl = 'postgresql://postgres:postgres@127.0.0.1:5432/resumable_upload_kit_test'

export default async function globalSetup(): Promise<() => Promise<void>> {
  const databaseUrl = process.env.TEST_DATABASE_URL ?? defaultDatabaseUrl
  const uploadDirectory = await mkdtemp(join(tmpdir(), 'resumable-upload-e2e-'))
  const identityProvider = await startTestIdentityProvider()
  let api: Awaited<ReturnType<typeof createProductionApi>> | null = null

  try {
    api = await createProductionApi(
      {
        audience,
        databasePoolSize: 4,
        databaseUrl,
        host: '127.0.0.1',
        issuer: identityOrigin,
        jwksUrl: `${identityOrigin}jwks.json`,
        port: apiPort,
        uploadDirectory,
      },
      { logger: false },
    )
    const pool = new Pool({ connectionString: databaseUrl })
    try {
      await pool.query('TRUNCATE resumable_uploads')
    } finally {
      await pool.end()
    }
    await api.listen({ host: '127.0.0.1', port: apiPort })
  } catch (error) {
    await api?.close().catch(() => undefined)
    await identityProvider.close().catch(() => undefined)
    await rm(uploadDirectory, { force: true, recursive: true })
    throw error
  }

  return async () => {
    await api.close()
    await identityProvider.close()
    await rm(uploadDirectory, { force: true, recursive: true })
  }
}
