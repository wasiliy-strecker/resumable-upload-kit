# Authenticated API contract

The demo API demonstrates how an application supplies identity to the framework-independent upload
service. The library deliberately has no opinion about login pages, sessions, or identity vendors.

## Token validation

The application validates compact JWT access tokens against a remote JWKS. It accepts only the
configured asymmetric algorithms and requires matching `iss` and `aud` claims plus `sub`, `iat`,
and `exp`. Five seconds of clock tolerance absorb small host drift. Subjects must contain 1 to 200
characters, have no surrounding whitespace, and are stored as opaque owner identifiers.

Invalid signatures, expired tokens, unsupported algorithms, malformed tokens, and unknown key IDs
all map to the same `401` response. This avoids revealing which part of a credential was useful to
an attacker. Network or operational failures while retrieving keys remain server failures and are
sanitized by the tus adapter rather than incorrectly blaming the caller.

Remote issuer and JWKS configuration requires HTTPS. Loopback HTTP remains available for a local
identity provider. The application does not log bearer tokens and no token enters upload metadata,
filesystem paths, or PostgreSQL upload rows.

## Authorization and resource privacy

The verified JWT subject is passed to every upload service operation. PostgreSQL queries constrain
resource lookup by both upload ID and owner ID. A valid user requesting another user's upload gets
the same `404` as a random unknown identifier. This prevents the endpoint from acting as an upload
existence oracle.

The current policy is deliberately narrow: a subject owns its uploads. Roles, organizations,
delegation, sharing, and administrative access are application-specific and are not inferred from
unvalidated token claims.

## Availability and lifecycle

`/health/live` proves that the Fastify process can answer. `/health/ready` executes `SELECT 1` on the
pool and returns a sanitized `503` when PostgreSQL is unavailable. Neither endpoint exposes
credentials or internal exception details.

Database migrations run before the listener starts. If they fail, the pool is closed and startup
fails. `SIGINT` or `SIGTERM` triggers one idempotent shutdown sequence that closes Fastify and then
the pool. An integration test creates an owned upload, closes the complete application, creates a
new pool and application, and verifies both recovery by its owner and continued isolation from a
second owner.

TLS termination, request-rate limiting, malware scanning, and identity-provider operations remain
deployment responsibilities and are not claimed by this example.
