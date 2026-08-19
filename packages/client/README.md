# `@resumable-upload-kit/client`

Framework-independent tus browser client with restart-safe IndexedDB checkpoints, chunk checksums,
bounded retry, and explicit recovery after ambiguous network failures.

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

const source = await createFileUploadSource(file)
const task = await client.create({
  metadata: [{ key: 'filename', value: new TextEncoder().encode(file.name) }],
  source,
})

task.subscribe(({ confirmedOffset, status, totalBytes }) => {
  console.log({ confirmedOffset, status, totalBytes })
})

await task.start()
```

Only checkpoints are persisted. File contents and authorization headers never enter IndexedDB. To
resume after a browser restart, the application provides the selected file again:

```ts
const [checkpoint] = await client.list()
const source = await createFileUploadSource(reselectedFile)
const task = await client.resume(checkpoint.id, source)
await task.start()
```

The default File fingerprint hashes metadata plus bounded first and last samples. It is an identity
guard, not a full-file content proof. Applications with a stronger content identity can pass it as
`createFileUploadSource(file, { fingerprint })`.

See the repository's [browser recovery contract](../../docs/client-recovery.md) for retry,
cancellation, CORS, and interrupted-creation semantics.
