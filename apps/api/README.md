# Authenticated demo API

This Fastify application is the production-shaped integration example for the repository. It wires
the reusable upload service to PostgreSQL, filesystem blobs, and an external OpenID Connect style
JSON Web Key Set without moving authentication concerns into the library packages.

## Authentication contract

Every mutating or resource-specific upload request needs an asymmetric JWT access token:

```http
Authorization: Bearer eyJ...
```

The verifier checks the configured issuer and audience, an explicit asymmetric algorithm allowlist,
signature, `iat`, `exp`, and `sub`. The subject becomes the upload owner identifier. Invalid and
expired tokens receive the same `401` response. A JWKS infrastructure failure is not presented as
a bad credential; it produces a sanitized server error instead.

The API consumes access tokens but does not issue them. Login, consent, MFA, and user lifecycle stay
with the chosen identity provider. See the repository's
[authenticated API contract](../../docs/authenticated-api.md) for exact trust boundaries.

## Configuration

Copy `.env.example` to an ignored local file or export the variables through the process manager.
The example database URL targets the PostgreSQL service in the repository's `compose.yaml`.

Required settings:

- `DATABASE_URL`
- `JWT_ISSUER`
- `JWT_AUDIENCE`
- `JWT_JWKS_URL`

Optional settings have bounded defaults: `API_HOST`, `API_PORT`, `DATABASE_POOL_SIZE`, and
`UPLOAD_DIRECTORY`. Remote issuer and JWKS endpoints must use HTTPS. HTTP is accepted only for
loopback development endpoints.

```bash
docker compose up -d postgres
pnpm install
cp apps/api/.env.example apps/api/.env
pnpm --filter resumable-upload-kit-api build
node --env-file=apps/api/.env apps/api/dist/main.js
```

The application exposes:

- `GET /health/live` for process liveness
- `GET /health/ready` for PostgreSQL readiness
- `OPTIONS /uploads` for public tus capability discovery
- authenticated tus creation, inspection, append, and termination routes under `/uploads`

`SIGINT` and `SIGTERM` stop accepting work, close Fastify, and drain the PostgreSQL pool. Startup
migrations use a PostgreSQL advisory transaction lock so concurrent instances can initialize
safely.
