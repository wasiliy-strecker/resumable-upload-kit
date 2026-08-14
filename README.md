# Resumable Upload Kit

[![CI](https://github.com/wasiliy-strecker/resumable-upload-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/wasiliy-strecker/resumable-upload-kit/actions/workflows/ci.yml)
![Node.js CI](https://img.shields.io/badge/Node.js_CI-22_%7C_24_%7C_26-339933)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Production-minded resumable uploads for React and Node.js with tus 1.0 compatibility,
PostgreSQL coordination, streaming filesystem storage, checksum validation, and failure-driven
browser tests.

The repository is being built in independently verifiable milestones. Its current protocol
package provides strict, runtime-tested contracts for the stable tus 1.0 target. Server, browser,
and React packages will consume the same contracts instead of duplicating header semantics.

## Why this repository exists

Reliable uploads are a coordination problem, not a progress-bar problem. A useful implementation
must distinguish confirmed bytes from bytes that may only have reached a socket, reconcile offsets
after ambiguous failures, bound memory use, and prevent concurrent requests from corrupting one
upload.

This project makes those guarantees and their limits explicit. It is an educational implementation
with interoperability evidence, not a claim to replace mature general-purpose tus servers.

## Implemented foundation

- tus 1.0 version negotiation and capability headers
- safe integer parsing for upload lengths and offsets
- strict `application/offset+octet-stream` validation
- bounded, duplicate-safe, injection-resistant metadata parsing
- SHA-1 and SHA-256 checksum header contracts
- structured protocol errors with HTTP status and response headers
- property tests for metadata round trips
- dual ESM/CommonJS builds with generated type declarations

The exact protocol surface and intentional omissions are documented in the
[compatibility matrix](docs/protocol-compatibility.md).

## Public protocol API

```ts
import {
  parseTusResumable,
  parseUploadMetadata,
  parseUploadOffset,
  tusOffsetContentType,
} from '@resumable-upload-kit/protocol'

parseTusResumable(request.headers.get('Tus-Resumable'))
const offset = parseUploadOffset(request.headers.get('Upload-Offset'))
const metadata = parseUploadMetadata(request.headers.get('Upload-Metadata'))
```

Invalid input throws a `TusProtocolError` containing a stable error code, HTTP status, and any
mandatory response headers. Metadata values remain binary `Uint8Array` values; application code
decides whether a value is text.

## Planned architecture

```text
packages/protocol/                     Runtime tus contracts (implemented)
packages/server/                       Framework-neutral upload service and Fastify adapter
packages/storage-postgres-filesystem/  Durable offsets, leases, and bounded blob streaming
packages/client/                       Browser upload state machine and IndexedDB persistence
packages/react/                        React hook over the framework-neutral client
apps/api/                              Authenticated Fastify integration example
apps/web/                              Accessible React recovery demo
```

The first persistent adapter will keep upload ownership, offset, status, leases, and expiration in
PostgreSQL 17. Bytes will be staged and checksummed through Node.js streams before being appended to
opaque filesystem paths. Confirmed database offsets will remain the recovery authority after a
process crash.

## Development

Requirements: Node.js 22.12 or newer and pnpm 11.13.1.

```bash
pnpm install
pnpm verify
```

`pnpm verify` checks formatting, strict ESLint rules, TypeScript, tests with enforced coverage, and
publishable package builds. CI repeats the complete verification on Node.js 22, 24, and 26.

## Roadmap

1. Protocol contracts and compatibility matrix — implemented
2. PostgreSQL and filesystem-backed server
3. Framework-independent browser client and React hook
4. Authenticated demo with failure-driven Playwright scenarios
5. Cleanup worker, observability, operational documentation, and GitHub `v0.1.0`

## License

[MIT](LICENSE)
