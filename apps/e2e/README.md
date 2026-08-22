# Failure-driven browser tests

This package verifies the complete React-to-PostgreSQL upload path in Chromium. The suite starts an
ephemeral OpenID Connect issuer, the real authenticated Fastify API, and the Vite web application.
Only the identity provider is a test fixture; upload coordination and persistence use the production
implementations.

The test issuer implements the narrow protocol surface needed by the application:

- OpenID Connect discovery and JWKS
- Authorization Code with mandatory S256 PKCE
- one-time, short-lived authorization codes
- signed ID tokens and API access tokens
- user info and post-logout redirect

It is deterministic test infrastructure, not a general-purpose identity provider.

## Run locally

Start PostgreSQL 17 using the repository service, install Chromium once, build the workspace, and
run the browser suite:

```bash
docker compose up -d postgres
pnpm install
pnpm build
pnpm --filter resumable-upload-kit-e2e exec playwright install chromium
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/resumable_upload_kit_test \
  pnpm test:e2e
```

Playwright starts and stops the remaining services. Upload blobs use a temporary directory and the
upload table is truncated at suite startup. Do not point `TEST_DATABASE_URL` at a shared or
production database.

Failure artifacts are written to ignored `test-results/` and `playwright-report/` directories. CI
retains the HTML report for fourteen days, including traces, screenshots, and video on failure.
