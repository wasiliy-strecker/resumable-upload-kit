# Authenticated React recovery demo

This React 19 and Vite application demonstrates the browser client and React hooks behind a real
authentication boundary. It is intentionally provider-neutral: any OpenID Connect provider that
supports public browser clients and Authorization Code with PKCE can be used.

## What the demo proves

- login and callback handling without a client secret in browser code
- StrictMode-safe session bootstrap and OIDC lifecycle subscriptions
- request-time access-token resolution, including renewed tokens
- same-origin upload requests through the Vite development proxy
- separate IndexedDB checkpoint databases per authenticated subject
- recovery after reload through explicit original-file reselection
- accessible progress, error announcements, and keyboard-operable actions

Only recovery metadata is stored in IndexedDB. File contents are read from the user-selected
`File`, and the OIDC library keeps its state in `sessionStorage`. Signing in as another subject
creates a different checkpoint database.

## Identity-provider setup

Register a public single-page application with these local redirect locations:

```text
http://localhost:5173/auth/callback
http://localhost:5173/
```

Enable Authorization Code with PKCE. Do not create or expose a client secret for the browser app.
The API must accept access tokens issued for its configured audience as documented in the
[authenticated API example](../api/README.md).

Copy the example configuration and replace the issuer and client ID:

```bash
cp apps/web/.env.example apps/web/.env.local
```

| Variable               | Purpose                                                         |
| ---------------------- | --------------------------------------------------------------- |
| `VITE_OIDC_AUTHORITY`  | HTTPS OIDC issuer or loopback HTTP issuer for local development |
| `VITE_OIDC_CLIENT_ID`  | Public SPA client ID                                            |
| `VITE_OIDC_SCOPE`      | Space-delimited scopes and must include `openid`                |
| `VITE_UPLOAD_ENDPOINT` | Same-origin upload path and defaults to `/uploads`              |
| `API_PROXY_TARGET`     | Local Vite proxy target and defaults to `http://127.0.0.1:3000` |

The app rejects absolute upload endpoints. This keeps bearer-token requests on the application
origin and leaves cross-origin routing to a controlled reverse proxy.

## Run locally

Start PostgreSQL and configure the authenticated API first. Then run both applications from the
repository root in separate terminals (build the API once before starting it):

```bash
pnpm --filter resumable-upload-kit-api build
pnpm --filter resumable-upload-kit-api start
pnpm --filter resumable-upload-kit-web dev
```

Open `http://localhost:5173`. The Vite server forwards `/uploads` and `/health` to the configured
API target.

Useful web-only checks:

```bash
pnpm --filter resumable-upload-kit-web typecheck
pnpm --filter resumable-upload-kit-web build
pnpm exec vitest run apps/web/test
```

The workspace-level `pnpm verify` remains the release gate and includes formatting, linting,
strict TypeScript, coverage thresholds, and every build.

## Recovery flow

1. A selected file becomes a browser `UploadSource` and starts in checksummed chunks.
2. Confirmed server offsets are persisted as a subject-scoped checkpoint.
3. A reload lists incomplete checkpoints but does not retain the file bytes.
4. The user selects the original file again.
5. The client verifies its fingerprint, reconciles the server offset, and continues.

Source mismatch, expired authentication, stale remote uploads, and ambiguous network failures are
presented as distinct recovery states. Exact guarantees and intentional limits are documented in
the [authenticated recovery contract](../../docs/authenticated-react-demo.md).
