# `@resumable-upload-kit/react`

StrictMode-safe React hooks over the framework-independent resumable upload client. The package
does not duplicate transport, retry, checksum, or persistence logic.

```tsx
import { useResumableUpload } from '@resumable-upload-kit/react'
import { createFileUploadSource, type ResumableUploadClient } from '@resumable-upload-kit/client'

function UploadInput({ client }: { client: ResumableUploadClient }) {
  const upload = useResumableUpload(client)

  async function selectFile(file: File): Promise<void> {
    await upload.create({ source: await createFileUploadSource(file) })
    await upload.start()
  }

  return (
    <label>
      {upload.state?.status ?? 'Select file'}
      <input
        disabled={upload.operationStatus !== 'idle'}
        type="file"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0]
          if (file) void selectFile(file)
        }}
      />
    </label>
  )
}
```

`useUploadTask(task)` is the low-level subscription hook. It uses React's external-store contract,
including a server snapshot for SSR. `usePendingUploads(client)` loads restart-safe checkpoints for
a recovery screen and exposes an explicit `refresh` operation.

Unmounting a component only removes subscriptions. It never pauses or cancels an upload. Starting,
pausing, canceling, and clearing the selected task are explicit application decisions.

If overlapping `create` or `resume` calls settle out of order, only the most recent operation may
become the selected task. The caller still receives every returned task and can decide how to
handle an intentionally concurrent workflow.
