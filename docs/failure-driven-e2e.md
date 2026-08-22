# Failure-driven E2E contract

The Playwright suite validates recovery guarantees at boundaries that unit tests cannot represent:
a browser process, IndexedDB, OIDC redirects, HTTP response loss, PostgreSQL coordination, and
filesystem blobs.

## System under test

```text
Chromium → Vite same-origin proxy → authenticated Fastify API
    │                                  │
    ├─ sessionStorage: OIDC session    ├─ PostgreSQL: confirmed offset and owner
    └─ IndexedDB: recovery metadata    └─ filesystem: staged and confirmed bytes
```

An ephemeral issuer performs a real Authorization Code flow and rejects authorization requests that
do not use S256 PKCE. Its RSA-signed access tokens are validated by the API through the normal
remote-JWKS verifier. Alice and Bob receive different `sub` claims.

## Scenarios

| Failure boundary                                          | Expected evidence                                                                                  |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| First `PATCH` commits but its browser response is dropped | Client issues `HEAD`, accepts the server-confirmed offset, and completes without duplicating bytes |
| Browser reloads while the second chunk request fails      | IndexedDB retains the first confirmed chunk and the recovery list survives reload                  |
| Bob signs in on Alice's browser profile                   | Bob sees an empty recovery list because checkpoint databases are subject-scoped                    |
| Alice returns and selects a different file                | Resume is rejected locally with a source-mismatch explanation                                      |
| Alice reselects the original file                         | Client reconciles and completes the existing remote upload                                         |

The response-loss scenario deliberately lets the request reach the real API before Playwright aborts
delivery of the response. This models an ambiguous network result rather than a server rejection.

## CI boundary

The browser job runs independently from unit verification and PostgreSQL integration tests. It uses
Chromium and PostgreSQL 17, builds the same packages consumed by Vite and Fastify, and uploads the
Playwright report even when a scenario fails. One worker keeps network fault injection deterministic.

The suite does not emulate process crashes or damaged disks. Those remain adapter-level concerns;
future operational tests can add controlled API restarts and cleanup-worker behavior.
