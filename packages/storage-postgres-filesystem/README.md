# `@resumable-upload-kit/storage-postgres-filesystem`

Durable adapters for `@resumable-upload-kit/server`:

- `PostgresUploadRepository` stores ownership, confirmed offsets, lifecycle state, and writer leases
- the same repository claims cleanup work with expiring leases and `FOR UPDATE SKIP LOCKED`
- `FileSystemUploadBlobStore` stages chunks, validates their length, syncs appends, and reconciles
  unconfirmed crash tails
- `runUploadMigrations` applies the idempotent schema under a PostgreSQL advisory transaction lock

```ts
const repository = new PostgresUploadRepository(pool)
const blobStore = new FileSystemUploadBlobStore({ rootDirectory: './var/uploads' })
await runUploadMigrations(pool)
```

Only generated UUIDs become filenames. User metadata never participates in path construction. The
database offset is authoritative: excess filesystem bytes are truncated on recovery, while a blob
shorter than the confirmed offset is reported as corruption.

Cleanup claims are durable and safe across multiple application instances. A worker marks eligible
active uploads as expired while claiming them, skips live writer leases, and increments an attempt
counter. Successful blob deletion sets `purged_at`; the upload row remains as an expired or
terminated tombstone. If deletion or the process fails, release or claim expiry makes the work
eligible again. Filesystem deletion is idempotent, so a crash between deleting bytes and recording
the purge is safe to retry.
