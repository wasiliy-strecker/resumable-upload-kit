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
and SHA-256 chunks without coupling the state machine to React. A separate hook package connects
that state machine to concurrent React rendering, StrictMode, and server rendering. The authenticated
demo API validates external JWTs and binds their subjects to durable upload ownership.

## Why this repository exists

Reliable uploads are a coordination problem, not a progress-bar problem. A useful implementation
must distinguish confirmed bytes from bytes that may only have reached a socket, reconcile offsets
after ambiguous failures, bound memory use, and prevent concurrent requests from corrupting one
upload.

This project makes those guarantees and their limits explicit. It is an educational implementation
with interoperability evidence, not a claim to replace mature general-purpose tus servers.

## Implemented foundation

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
- StrictMode-safe React subscriptions through `useSyncExternalStore`
- explicit React actions and stale-result protection for overlapping recovery operations
- asymmetric JWT validation through issuer-scoped JWKS
- OIDC Authorization Code with PKCE for the React demo, without a browser client secret
- subject-scoped IndexedDB recovery and request-time access-token resolution
- accessible upload, pause, cancellation, and original-file reselection workflows
- liveness, PostgreSQL readiness, startup migrations, and graceful shutdown
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

## Authenticated demo API

`apps/api` shows the packages inside a deployable Node.js boundary. It validates JWT signature,
issuer, audience, expiration, issued-at time, and subject against a remote JWKS. The verified
subject is the only identity passed into upload operations, so foreign and unknown resources both
remain `404`.

The application also validates environment configuration, runs migrations before listening,
provides separate liveness and PostgreSQL readiness endpoints, and drains its pool on shutdown. Its
[README](apps/api/README.md) covers local operation; the
[authentication contract](docs/authenticated-api.md) documents guarantees and intentional limits.

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

## Public React API

```tsx
import { usePendingUploads, useResumableUpload } from '@resumable-upload-kit/react'
import { createFileUploadSource, type ResumableUploadClient } from '@resumable-upload-kit/client'
import type { ChangeEvent } from 'react'

function RecoveryPanel({ client }: { client: ResumableUploadClient }) {
  const pending = usePendingUploads(client)
  const upload = useResumableUpload(client)

  async function resumeCheckpoint(
    event: ChangeEvent<HTMLInputElement>,
    checkpointId: string,
  ): Promise<void> {
    const file = event.currentTarget.files?.[0]
    if (!file) return

    await upload.resume(checkpointId, await createFileUploadSource(file))
    await upload.start()
    await pending.refresh()
  }

  return pending.checkpoints.map((checkpoint) => {
    return (
      <label key={checkpoint.id}>
        Resume {checkpoint.id}
        <input type="file" onChange={(event) => void resumeCheckpoint(event, checkpoint.id)} />
      </label>
    )
  })
}
```

`useUploadTask` is the minimal external-store adapter for applications that own task selection.
`useResumableUpload` adds explicit orchestration actions without starting work from an effect, and
`usePendingUploads` provides restart recovery with deduplicated StrictMode loading. Component
unmount only unsubscribes; it never cancels a running upload. The precise boundaries are documented
in the [React lifecycle contract](docs/react-lifecycle.md).

## Authenticated React recovery demo

`apps/web` turns the public packages into a production-shaped React 19 application. It uses a
generic OpenID Connect provider through Authorization Code with PKCE, resolves the current access
token for every upload request, and keeps each authenticated subject's checkpoints in a separate
IndexedDB database. Access tokens and file contents are never written to the checkpoint store.

The Vite development server proxies `/uploads` to the demo API, mirroring the recommended
same-origin production deployment. The interface supports new uploads, progress, pause, continue,
cancel, stale-checkpoint removal, and explicit original-file reselection after reload. See the
[web app README](apps/web/README.md) for local configuration and the
[authenticated recovery contract](docs/authenticated-react-demo.md) for security and failure
semantics.

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
packages/react/                        React hooks over the framework-neutral client (implemented)
apps/api/                              Authenticated Fastify integration example (implemented)
apps/web/                              Accessible React recovery demo (implemented)
```

The browser package depends only on Web Platform APIs and the protocol package. React integration
remains a thin subscription adapter so upload correctness can be tested without component
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
4. React hooks over the client state machine — implemented
5. Authenticated Fastify demo API — implemented
6. Accessible React recovery demo — implemented
7. Failure-driven Playwright scenarios
8. Cleanup worker, observability, operational documentation, and GitHub `v0.1.0`

## License

[MIT](LICENSE)
