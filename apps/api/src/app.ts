import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'

import { registerResumableUploadRoutes } from '@resumable-upload-kit/server/fastify'
import type { UploadService } from '@resumable-upload-kit/server'

import { createOwnerResolver, type AccessTokenVerifier } from './auth.js'

export interface CreateApiAppOptions {
  readonly accessTokenVerifier: AccessTokenVerifier
  readonly logger?: boolean
  readonly readiness?: () => Promise<void>
  readonly service: UploadService
}

export function createApiApp(options: CreateApiAppOptions): FastifyInstance {
  const app = Fastify({
    bodyLimit: options.service.limits.maximumChunkBytes,
    logger: options.logger ?? false,
  })

  app.get('/health/live', async (_request, reply) => {
    return reply.header('Cache-Control', 'no-store').code(200).send({ status: 'ok' })
  })

  app.get('/health/ready', async (_request, reply) => {
    try {
      await options.readiness?.()
      return reply.header('Cache-Control', 'no-store').code(200).send({ status: 'ready' })
    } catch {
      return reply
        .header('Cache-Control', 'no-store')
        .code(503)
        .type('application/problem+json')
        .send({
          code: 'not_ready',
          detail: 'The upload service is temporarily unavailable',
          status: 503,
          title: 'Service Unavailable',
          type: 'https://resumable-upload-kit.dev/problems/not-ready',
        })
    }
  })

  registerResumableUploadRoutes(app, {
    resolveOwner: createOwnerResolver(options.accessTokenVerifier),
    service: options.service,
  })

  return app
}
