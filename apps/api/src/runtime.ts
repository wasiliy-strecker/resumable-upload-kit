import type { FastifyInstance } from 'fastify'
import { Pool, type PoolConfig } from 'pg'

import {
  createUploadCleanupWorker,
  createUploadService,
  startUploadCleanupScheduler,
  type UploadCleanupWorker,
} from '@resumable-upload-kit/server'
import {
  FileSystemUploadBlobStore,
  PostgresUploadRepository,
  runUploadMigrations,
} from '@resumable-upload-kit/storage-postgres-filesystem'

import { createApiApp } from './app.js'
import { createAccessTokenVerifier, type AccessTokenVerifier } from './auth.js'
import type { ApiConfig } from './config.js'

export interface ProductionApiDependencies {
  readonly accessTokenVerifier?: AccessTokenVerifier
  readonly cleanupWorker?: UploadCleanupWorker
  readonly createPool?: (config: PoolConfig) => Pool
  readonly logger?: boolean
  readonly migrate?: (pool: Pool) => Promise<void>
}

export async function createProductionApi(
  config: ApiConfig,
  dependencies: ProductionApiDependencies = {},
): Promise<FastifyInstance> {
  const pool = (dependencies.createPool ?? ((options) => new Pool(options)))({
    connectionString: config.databaseUrl,
    max: config.databasePoolSize,
  })

  try {
    await (dependencies.migrate ?? runUploadMigrations)(pool)
  } catch (error) {
    await pool.end().catch(() => undefined)
    throw error
  }

  const blobStore = new FileSystemUploadBlobStore({ rootDirectory: config.uploadDirectory })
  const repository = new PostgresUploadRepository(pool)

  const app = createApiApp({
    accessTokenVerifier:
      dependencies.accessTokenVerifier ??
      createAccessTokenVerifier({
        audience: config.audience,
        issuer: config.issuer,
        jwksUrl: config.jwksUrl,
      }),
    logger: dependencies.logger ?? true,
    readiness: async () => {
      await pool.query('SELECT 1')
    },
    service: createUploadService({ blobStore, repository }),
  })

  const cleanupWorker =
    dependencies.cleanupWorker ??
    createUploadCleanupWorker({
      batchSize: config.cleanupBatchSize,
      blobStore,
      claimDurationMs: config.cleanupClaimDurationMs,
      concurrency: config.cleanupConcurrency,
      repository,
    })
  let cleanupScheduler: ReturnType<typeof startUploadCleanupScheduler> | undefined

  app.addHook('onReady', () => {
    cleanupScheduler = startUploadCleanupScheduler(cleanupWorker, {
      intervalMs: config.cleanupIntervalMs,
      onError: (error) => {
        app.log.error({ err: error }, 'Upload cleanup run failed')
      },
      onResult: (result) => {
        if (result.claimed > 0) app.log.info(result, 'Upload cleanup run completed')
      },
    })
  })

  pool.on('error', (error) => {
    app.log.error({ err: error }, 'Idle PostgreSQL client failed')
  })
  app.addHook('onClose', async () => {
    await cleanupScheduler?.stop()
    await pool.end()
  })

  return app
}
