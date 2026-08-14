# `@resumable-upload-kit/protocol`

Browser- and Node-compatible tus 1.0 contracts for the Resumable Upload Kit. The package contains no
HTTP framework, storage implementation, or Node.js-only runtime dependency.

```ts
import {
  parseTusResumable,
  parseUploadMetadata,
  parseUploadOffset,
} from '@resumable-upload-kit/protocol'

parseTusResumable(headers.get('Tus-Resumable'))
const offset = parseUploadOffset(headers.get('Upload-Offset'))
const metadata = parseUploadMetadata(headers.get('Upload-Metadata'))
```

All validation failures throw `TusProtocolError` with a stable `code`, HTTP `status`, and response
headers when the tus specification requires them. Metadata parsing is bounded by default and keeps
values as `Uint8Array` so callers do not accidentally assume untrusted binary data is text.

See the repository's
[compatibility contract](https://github.com/wasiliy-strecker/resumable-upload-kit/blob/main/docs/protocol-compatibility.md)
for implemented and deliberately unsupported protocol features.
