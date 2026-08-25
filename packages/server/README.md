# `@resumable-upload-kit/server`

Node.js upload orchestration for the Resumable Upload Kit. The root entry point is independent of
HTTP frameworks; the `@resumable-upload-kit/server/fastify` subpath adapts it to Fastify 5.

```ts
import { createUploadService } from '@resumable-upload-kit/server'

const service = createUploadService({ blobStore, repository })
```

`UploadRepository` coordinates ownership, offsets, expiration, and exclusive writer leases.
`UploadBlobStore` stages, reconciles, appends, syncs, and deletes opaque bytes. Implementations can
be replaced independently.

The default limits are a 250 MiB upload, 5 MiB chunk, 24-hour expiration, and 30-second writer
lease. They are explicit service configuration rather than protocol constants.

## Cleanup worker

`createUploadCleanupWorker` combines an `UploadCleanupRepository` with the delete capability of an
`UploadBlobStore`. A run claims at most 50 uploads by default and deletes four blobs concurrently.
Both values and the five-minute claim duration are configurable.

```ts
import {
  createUploadCleanupWorker,
  startUploadCleanupScheduler,
} from '@resumable-upload-kit/server'

const worker = createUploadCleanupWorker({ blobStore, repository })
const scheduler = startUploadCleanupScheduler(worker, {
  intervalMs: 60_000,
  onError: (error) => logger.error(error),
  onResult: (result) => logger.info(result),
})

await scheduler.stop()
```

The scheduler starts one run immediately and schedules the next only after it finishes, so cleanup
runs never overlap inside one process. `stop()` cancels future work and waits for the active run.

## Telemetry

`UploadTelemetry` receives a closed union of provider-neutral events. `createUploadService` and
`createUploadCleanupWorker` accept it as an optional dependency. Observers receive only operation
names, bounded outcomes and error codes, durations, byte counts, and aggregate cleanup results.
They never receive an upload ID, owner, metadata, filename, token, or error message.

```ts
const telemetry = {
  record(event) {
    metrics.record(event)
  },
}

const service = createUploadService({ blobStore, repository, telemetry })
const cleanup = createUploadCleanupWorker({ blobStore, repository, telemetry })
```

Observer exceptions are isolated from upload and cleanup correctness. Existing `UploadService`
implementations can be wrapped with `instrumentUploadService` instead of being reconstructed.
