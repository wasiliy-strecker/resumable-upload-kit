# tus 1.0 compatibility contract

The stable [tus 1.0 protocol](https://tus.io/protocols/resumable-upload) is the normative target.
The evolving IETF resumable-upload draft is deliberately not implemented until its wire contract is
stable. Every partial feature is documented here rather than being advertised as full tus support.

## Current protocol foundation

| Contract                                          | Status      | Evidence                                        |
| ------------------------------------------------- | ----------- | ----------------------------------------------- |
| `Tus-Resumable: 1.0.0` validation                 | Implemented | Runtime parser and version-negotiation tests    |
| `Tus-Version` and capability headers              | Implemented | Deterministic options-header tests              |
| Non-negative `Upload-Length` / `Upload-Offset`    | Implemented | Boundary and unsafe-integer tests               |
| Offset payload content type                       | Implemented | Strict media-type tests                         |
| `Upload-Metadata` parsing                         | Implemented | Limit, injection, duplicate, and property tests |
| `Upload-Checksum` with SHA-1 and SHA-256          | Implemented | Digest syntax and length tests                  |
| HTTP `OPTIONS`, `POST`, `HEAD`, `PATCH`, `DELETE` | Planned     | Server milestone                                |

The protocol package validates wire values but does not currently expose an HTTP server. A consumer
must not advertise this repository as an operational tus endpoint until the server milestone lands.

## Server target

| tus area             | Version 0.1 target | Notes                                                       |
| -------------------- | ------------------ | ----------------------------------------------------------- |
| Core protocol        | Yes                | Offset discovery and sequential append                      |
| Creation             | Yes                | Known `Upload-Length` and bounded metadata                  |
| Checksum             | Yes                | SHA-1 required for compatibility; SHA-256 preferred by demo |
| Expiration           | Yes                | Incomplete resources expire after a configured deadline     |
| Termination          | Yes                | Owner-authorized cleanup with idempotent resource deletion  |
| Creation with upload | No                 | Creation requests remain body-free in version 0.1           |
| Deferred length      | No                 | Total length must be known before creation                  |
| Concatenation        | No                 | Parallel partial uploads are outside the first release      |
| Method override      | No                 | Demo and supported runtimes can issue `PATCH` and `DELETE`  |

An `OPTIONS` response will only advertise extensions implemented end to end. The existing header
helper requires an explicit, internally consistent capability set and never enables extensions by
default.

## Error semantics

Protocol failures use `TusProtocolError` so adapters can map errors without parsing message text.
The model preserves a stable code, HTTP status, human-readable message, optional cause, and mandatory
response headers such as `Tus-Version` during a `412 Precondition Failed` response.

Checksum mismatch (`460`) and offset conflict (`409`) belong to the server milestone because they
depend on received bytes and persisted upload state. Malformed headers are rejected before any body
is accepted.
