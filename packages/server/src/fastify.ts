import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import {
  TusProtocolError,
  assertOffsetContentType,
  createTusOptionsHeaders,
  createTusResponseHeaders,
  parseNonNegativeIntegerHeader,
  parseTusResumable,
  parseUploadChecksum,
  parseUploadLength,
  parseUploadMetadata,
  parseUploadOffset,
  serializeUploadMetadata,
  tusHeader,
} from '@resumable-upload-kit/protocol'

import type { UploadRecord, UploadService } from './types.js'

export interface ResumableUploadRouteOptions {
  readonly basePath?: string
  readonly resolveOwner: (request: FastifyRequest) => Promise<string | null> | string | null
  readonly service: UploadService
}

interface UploadParameters {
  readonly uploadId: string
}

export function registerResumableUploadRoutes(
  app: FastifyInstance,
  options: ResumableUploadRouteOptions,
): void {
  const basePath = normalizeBasePath(options.basePath ?? '/uploads')

  app.register((scopedApp, _pluginOptions, done) => {
    registerRoutes(scopedApp, options, basePath)
    done()
  })
}

function registerRoutes(
  app: FastifyInstance,
  options: ResumableUploadRouteOptions,
  basePath: string,
): void {
  app.addContentTypeParser('*', (_request, payload, done) => {
    done(null, payload)
  })

  app.options(basePath, async (_request, reply) => {
    setHeaders(
      reply,
      createTusOptionsHeaders({
        checksumAlgorithms: ['sha1', 'sha256'],
        extensions: ['creation', 'checksum', 'expiration', 'termination'],
        maximumUploadSize: options.service.limits.maximumUploadBytes,
      }),
    )
    return reply.code(204).send()
  })

  app.post(basePath, async (request, reply) =>
    handle(reply, async () => {
      parseTusResumable(header(request, 'tus-resumable'))
      const declaredBodyLength = optionalContentLength(request)

      if (declaredBodyLength !== null && declaredBodyLength !== 0) {
        throw new TusProtocolError({
          code: 'invalid_header',
          message: 'Creation-with-upload is not supported; POST body must be empty',
          status: 400,
        })
      }

      const ownerId = await requireOwner(request, options)
      const upload = await options.service.create({
        length: parseUploadLength(
          header(request, 'upload-length'),
          options.service.limits.maximumUploadBytes,
        ),
        metadata: parseUploadMetadata(header(request, 'upload-metadata')),
        ownerId,
      })
      setTusHeaders(reply)
      setExpiration(reply, upload)
      return reply.header('Location', `${basePath}/${upload.id}`).code(201).send()
    }),
  )

  app.head<{ Params: UploadParameters }>(`${basePath}/:uploadId`, async (request, reply) =>
    handle(reply, async () => {
      parseTusResumable(header(request, 'tus-resumable'))
      const ownerId = await requireOwner(request, options)
      const upload = await options.service.head(request.params.uploadId, ownerId)
      setTusHeaders(reply)
      setUploadHeaders(reply, upload)
      return reply.header('Cache-Control', 'no-store').code(200).send()
    }),
  )

  app.patch<{ Params: UploadParameters; Body: AsyncIterable<Uint8Array> }>(
    `${basePath}/:uploadId`,
    async (request, reply) =>
      handle(reply, async () => {
        parseTusResumable(header(request, 'tus-resumable'))
        assertOffsetContentType(header(request, 'content-type'))
        const contentLength = parseNonNegativeIntegerHeader(
          header(request, 'content-length'),
          'Content-Length',
          { maximum: options.service.limits.maximumChunkBytes },
        )

        if (contentLength === 0) {
          throw new TusProtocolError({
            code: 'invalid_header',
            message: 'Content-Length must be positive for PATCH',
            status: 400,
          })
        }

        const source = request.body

        if (!isByteStream(source)) {
          throw new TusProtocolError({
            code: 'invalid_header',
            message: 'PATCH body is not a readable byte stream',
            status: 400,
          })
        }

        const checksumHeader = header(request, 'upload-checksum')
        const ownerId = await requireOwner(request, options)
        const upload = await options.service.append({
          ...(checksumHeader === undefined
            ? {}
            : { checksum: parseUploadChecksum(checksumHeader) }),
          contentLength,
          offset: parseUploadOffset(header(request, 'upload-offset')),
          ownerId,
          source,
          uploadId: request.params.uploadId,
        })
        setTusHeaders(reply)
        setExpiration(reply, upload)
        return reply.header(tusHeader.uploadOffset, String(upload.offset)).code(204).send()
      }),
  )

  app.delete<{ Params: UploadParameters }>(`${basePath}/:uploadId`, async (request, reply) =>
    handle(reply, async () => {
      parseTusResumable(header(request, 'tus-resumable'))
      const ownerId = await requireOwner(request, options)
      await options.service.terminate(request.params.uploadId, ownerId)
      setTusHeaders(reply)
      return reply.code(204).send()
    }),
  )
}

async function requireOwner(
  request: FastifyRequest,
  options: ResumableUploadRouteOptions,
): Promise<string> {
  const ownerId = await options.resolveOwner(request)

  if (!ownerId) {
    throw new TusProtocolError({
      code: 'unauthorized',
      message: 'Authentication is required for upload resources',
      status: 401,
    })
  }

  return ownerId
}

async function handle(
  reply: FastifyReply,
  operation: () => Promise<FastifyReply>,
): Promise<FastifyReply> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof TusProtocolError) {
      setTusHeaders(reply)
      setHeaders(reply, error.headers)
      return reply
        .code(error.status)
        .type('application/problem+json')
        .send({
          code: error.code,
          detail: error.message,
          status: error.status,
          title: titleFor(error.status),
          type: `https://resumable-upload-kit.dev/problems/${error.code}`,
        })
    }

    setTusHeaders(reply)
    return reply.code(500).type('application/problem+json').send({
      code: 'internal_error',
      detail: 'The upload operation failed unexpectedly',
      status: 500,
      title: 'Internal Server Error',
      type: 'https://resumable-upload-kit.dev/problems/internal-error',
    })
  }
}

function setUploadHeaders(reply: FastifyReply, upload: UploadRecord): void {
  reply.header(tusHeader.uploadLength, String(upload.length))
  reply.header(tusHeader.uploadOffset, String(upload.offset))

  if (upload.metadata.length > 0) {
    reply.header(tusHeader.uploadMetadata, serializeUploadMetadata(upload.metadata))
  }

  setExpiration(reply, upload)
}

function setExpiration(reply: FastifyReply, upload: UploadRecord): void {
  if (upload.status === 'active' && upload.expiresAt) {
    reply.header(tusHeader.uploadExpires, upload.expiresAt.toUTCString())
  }
}

function setTusHeaders(reply: FastifyReply): void {
  setHeaders(reply, createTusResponseHeaders())
}

function setHeaders(reply: FastifyReply, headers: Readonly<Record<string, string>>): void {
  for (const [name, value] of Object.entries(headers)) {
    reply.header(name, value)
  }
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name]
  return Array.isArray(value) ? value[0] : value
}

function optionalContentLength(request: FastifyRequest): number | null {
  const value = header(request, 'content-length')
  return value === undefined ? null : parseNonNegativeIntegerHeader(value, 'Content-Length')
}

function isByteStream(value: unknown): value is AsyncIterable<Uint8Array> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === 'function'
  )
}

function normalizeBasePath(value: string): string {
  if (!value.startsWith('/') || value === '/' || value.endsWith('/')) {
    throw new Error('basePath must start with one slash and must not end with a slash')
  }

  return value
}

function titleFor(status: number): string {
  switch (status) {
    case 400:
      return 'Bad Request'
    case 401:
      return 'Unauthorized'
    case 404:
      return 'Not Found'
    case 409:
      return 'Conflict'
    case 410:
      return 'Gone'
    case 412:
      return 'Precondition Failed'
    case 413:
      return 'Content Too Large'
    case 415:
      return 'Unsupported Media Type'
    case 423:
      return 'Locked'
    case 460:
      return 'Checksum Mismatch'
    default:
      return 'Upload Error'
  }
}
