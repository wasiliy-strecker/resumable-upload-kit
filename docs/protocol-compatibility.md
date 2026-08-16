# tus 1.0 compatibility contract

The stable [tus 1.0 protocol](https://tus.io/protocols/resumable-upload) is the normative target.
The evolving IETF resumable-upload draft is deliberately not implemented until its wire contract is
stable. Every partial feature is documented here rather than being advertised as full tus support.

## Current protocol foundation

| Contract                                          | Status      | Evidence                                         |
| ------------------------------------------------- | ----------- | ------------------------------------------------ |
| `Tus-Resumable: 1.0.0` validation                 | Implemented | Runtime parser and version-negotiation tests     |
| `Tus-Version` and capability headers              | Implemented | Deterministic options-header tests               |
| Non-negative `Upload-Length` / `Upload-Offset`    | Implemented | Boundary and unsafe-integer tests                |
| Offset payload content type                       | Implemented | Strict media-type tests                          |
| `Upload-Metadata` parsing                         | Implemented | Limit, injection, duplicate, and property tests  |
| `Upload-Checksum` with SHA-1 and SHA-256          | Implemented | Digest syntax and length tests                   |
| HTTP `OPTIONS`, `POST`, `HEAD`, `PATCH`, `DELETE` | Implemented | Fastify adapter and PostgreSQL integration tests |

The protocol package remains browser-compatible and independent of HTTP frameworks. The Node.js
server package consumes those contracts through a framework-neutral service and exposes a Fastify 5
adapter.

## Server target

| tus area             | Version 0.1 target | Notes                                                      |
| -------------------- | ------------------ | ---------------------------------------------------------- |
| Core protocol        | Yes                | Offset discovery and sequential append                     |
| Creation             | Yes                | Known `Upload-Length` and bounded metadata                 |
| Checksum             | Yes                | Streaming SHA-1 and SHA-256 chunk validation               |
| Expiration           | Yes                | Incomplete resources expire after a configured deadline    |
| Termination          | Yes                | Owner-authorized tombstone and blob cleanup                |
| Creation with upload | No                 | Creation requests remain body-free in version 0.1          |
| Deferred length      | No                 | Total length must be known before creation                 |
| Concatenation        | No                 | Parallel partial uploads are outside the first release     |
| Method override      | No                 | Demo and supported runtimes can issue `PATCH` and `DELETE` |

`OPTIONS` only advertises extensions implemented end to end. The header helper requires an
explicit, internally consistent capability set and never enables extensions by default. Version
0.1 limits uploads to 250 MiB and each `PATCH` to 5 MiB by default; both values are configurable.

## Error semantics

Protocol failures use `TusProtocolError` so adapters can map errors without parsing message text.
The model preserves a stable code, HTTP status, human-readable message, optional cause, and mandatory
response headers such as `Tus-Version` during a `412 Precondition Failed` response.

Checksum mismatch (`460`), offset conflict (`409`), active-writer lock (`423`), expired or terminated
resource (`410`), and ownership-safe not found (`404`) are mapped by the server adapter. Malformed
headers are rejected before persistence is changed.
