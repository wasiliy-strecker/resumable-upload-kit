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
