# Browser client recovery contract

The browser client reports confirmed server progress, not bytes merely handed to `fetch`. Its
checkpoint offset only advances after a valid tus response or a later `HEAD` proves that the server
committed the chunk.

## State model

```text
creating ────────────────┐
                        v
paused → reconciling → uploading → completed
             │           │
             └→ retrying ←┘
                  │
                  └→ failed

paused/uploading/retrying → canceled
```

Every restart of an existing upload begins with `HEAD`. PostgreSQL remains authoritative for the
confirmed offset; a stale local checkpoint is corrected before another `PATCH` is sent.

## Ambiguous outcomes

| Event                                           | Client decision                                                      |
| ----------------------------------------------- | -------------------------------------------------------------------- |
| `PATCH` response is lost                        | Run `HEAD`; continue if the offset advanced, otherwise retry         |
| `409`, `423`, `429`, `460`, or retryable 5xx    | Reconcile with `HEAD`, honor `Retry-After`, then use bounded backoff |
| `HEAD` temporarily fails                        | Retry `HEAD`; never send a speculative chunk                         |
| Browser pauses during `PATCH`                   | Abort the request, keep the checkpoint, reconcile on the next start  |
| Initial `POST` is interrupted before `Location` | Mark `creation_ambiguous` and do not create a possible duplicate     |
| Cancellation `DELETE` returns `404`/`410`       | Treat remote cleanup as complete and delete the local checkpoint     |
| Cancellation has no response                    | Keep the checkpoint because remote cleanup is unconfirmed            |

Retries are bounded to five attempts by default. Exponential backoff starts at 500 ms and caps at
8 seconds. A valid server `Retry-After` takes precedence and is not shortened by the cap.

## Source identity

IndexedDB stores the remote URL, file size, source fingerprint, confirmed offset, metadata,
expiration, and timestamps. It deliberately stores neither access tokens nor the complete file.

`createFileUploadSource` derives a bounded sampled fingerprint from the file name, size, media type,
last-modified timestamp, and first and last 64 KiB. This catches normal wrong-file selection without
duplicating a potentially 250 MiB file in browser storage. It does not claim to be a full content
hash. Applications that already possess a strong content digest should provide it explicitly.

## Browser constraints

Fetch does not expose reliable byte-level upload progress. Progress events therefore move at
confirmed chunk boundaries. The browser supplies `Content-Length` for each Blob body; JavaScript
does not attempt to set that forbidden header.

For cross-origin use, the server must allow `POST`, `HEAD`, `PATCH`, `DELETE`, and these request
headers as applicable:

- `Authorization`
- `Content-Type`
- `Tus-Resumable`
- `Upload-Checksum`
- `Upload-Length`
- `Upload-Metadata`
- `Upload-Offset`

The server must expose `Location`, `Tus-Resumable`, `Upload-Expires`, `Upload-Length`, and
`Upload-Offset` response headers to browser JavaScript.
