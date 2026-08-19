# Resumable Upload Kit

[![CI](https://github.com/wasiliy-strecker/resumable-upload-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/wasiliy-strecker/resumable-upload-kit/actions/workflows/ci.yml)
![Node.js CI](https://img.shields.io/badge/Node.js_CI-22_%7C_24_%7C_26-339933)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Production-minded resumable uploads for React and Node.js with tus 1.0 compatibility,
PostgreSQL coordination, streaming filesystem storage, checksum validation, and failure-driven
browser tests.

The repository is being built in independently verifiable milestones. Its Node.js server implements
a deliberately bounded tus 1.0 subset over durable PostgreSQL coordination and streaming filesystem
blobs. A framework-independent browser client adds IndexedDB checkpoints, recovery-aware retries,
and SHA-256 chunks without coupling the state machine to React.

## Why this repository exists

Reliable uploads are a coordination problem, not a progress-bar problem. A useful implementation
must distinguish confirmed bytes from bytes that may only have reached a socket, reconcile offsets
after ambiguous failures, bound memory use, and prevent concurrent requests from corrupting one
upload.

This project makes those guarantees and their limits explicit. It is an educational implementation
with interoperability evidence, not a claim to replace mature general-purpose tus servers.

## Implemented server foundation

- tus 1.0 version negotiation and capability headers
- `OPTIONS`, known-length `POST`, `HEAD`, sequential `PATCH`, and `DELETE` routes for Fastify 5
- safe integer parsing for upload lengths and offsets
- strict `application/offset+octet-stream` validation
- bounded, duplicate-safe, injection-resistant metadata parsing
- streaming SHA-1 and SHA-256 chunk validation before lease acquisition
- PostgreSQL ownership, state, expiration, and 30-second writer leases
- filesystem staging, `fsync`, bounded-memory append, and crash-tail reconciliation
- structured protocol errors with HTTP status and response headers
- owner isolation that maps unknown and foreign upload IDs to the same `404`
- restart-safe browser checkpoints without persisting tokens or complete files
- server-authoritative `HEAD` reconciliation after ambiguous `PATCH` failures
- pause, resume, cancellation, bounded backoff, and chunk-level progress events
- unit, property, filesystem, and PostgreSQL 17 integration tests
- dual ESM/CommonJS builds with generated type declarations

The exact protocol surface and intentional omissions are documented in the
[compatibility matrix](docs/protocol-compatibility.md).

## Public server API

```ts
import Fastify from 'fastify'
import { Pool } from 'pg'

import { createUploadService } from '@resumable-upload-kit/server'
import { registerResumableUploadRoutes } from '@resumable-upload-kit/server/fastify'
import {
  FileSystemUploadBlobStore,
  PostgresUploadRepository,
  runUploadMigrations,
} from '@resumable-upload-kit/storage-postgres-filesystem'

const app = Fastify()
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
await runUploadMigrations(pool)

const service = createUploadService({
  blobStore: new FileSystemUploadBlobStore({ rootDirectory: './var/uploads' }),
  repository: new PostgresUploadRepository(pool),
})

registerResumableUploadRoutes(app, {
  resolveOwner: (request) => request.user?.id ?? null,
  service,
})
```

The service is independent of Fastify and depends only on the exported `UploadRepository` and
`UploadBlobStore` contracts. Applications can replace either adapter without changing protocol or
orchestration code.

## Public browser API

```ts
import {
  IndexedDbUploadCheckpointStore,
  createFileUploadSource,
  createResumableUploadClient,
} from '@resumable-upload-kit/client'

const client = createResumableUploadClient({
  checkpointStore: new IndexedDbUploadCheckpointStore(),
  endpoint: '/uploads',
  resolveHeaders: () => ({ Authorization: `Bearer ${accessToken}` }),
})

const task = await client.create({ source: await createFileUploadSource(file) })
task.subscribe(({ confirmedOffset, status, totalBytes }) => {
  renderProgress({ confirmedOffset, status, totalBytes })
})
await task.start()
```

After a browser restart, `client.list()` returns pending checkpoints. The application asks the user
for the file again, recreates the source, and calls `client.resume(checkpoint.id, source)`. The
[browser recovery contract](docs/client-recovery.md) documents source identity, ambiguous request
outcomes, and CORS requirements.

## Durability contract

PostgreSQL is the authority for the confirmed offset. A chunk is first staged and checksummed,
then a database lease serializes writers for one upload. The adapter reconciles the blob to the
confirmed offset, appends and syncs bytes, and only then advances PostgreSQL.

If the process dies after the file sync but before the database commit, extra bytes may remain on
disk. The next writer truncates that unconfirmed tail before retrying. If the blob is shorter than
the confirmed database offset, the operation fails as corruption rather than silently fabricating
success. The server provides sequential, at-most-one-writer coordination per upload; it does not
claim a distributed filesystem transaction or generic exactly-once delivery.

## Planned architecture

```text
packages/protocol/                     Runtime tus contracts (implemented)
packages/server/                       Upload orchestration and Fastify adapter (implemented)
packages/storage-postgres-filesystem/  PostgreSQL leases and filesystem blobs (implemented)
packages/client/                       Browser state machine and IndexedDB persistence (implemented)
packages/react/                        React hook over the framework-neutral client
apps/api/                              Authenticated Fastify integration example
apps/web/                              Accessible React recovery demo
```

The browser package depends only on Web Platform APIs and the protocol package. React integration
will remain a thin subscription adapter so upload correctness can be tested without component
lifecycle or rendering concerns.

## Development

Requirements: Node.js 22.12 or newer and pnpm 11.13.1.

```bash
pnpm install
pnpm verify
```

`pnpm verify` checks formatting, strict ESLint rules, TypeScript, tests with enforced coverage, and
publishable package builds. CI repeats the complete verification on Node.js 22, 24, and 26.

PostgreSQL integration tests run separately against PostgreSQL 17 so normal unit tests do not hide
infrastructure behind mocks:

```bash
docker compose up -d postgres
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/resumable_upload_kit_test \
  pnpm test:integration
```

## Roadmap

1. Protocol contracts and compatibility matrix — implemented
2. PostgreSQL and filesystem-backed server — implemented
3. Framework-independent browser client — implemented
4. React hook over the client state machine
5. Authenticated demo with failure-driven Playwright scenarios
6. Cleanup worker, observability, operational documentation, and GitHub `v0.1.0`

## License

[MIT](LICENSE)
