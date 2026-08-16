# `@resumable-upload-kit/storage-postgres-filesystem`

Durable adapters for `@resumable-upload-kit/server`:

- `PostgresUploadRepository` stores ownership, confirmed offsets, lifecycle state, and writer leases
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
