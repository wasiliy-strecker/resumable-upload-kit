# Operations runbook

This runbook describes the supported operational shape of Resumable Upload Kit `v0.1`. It is a
starting point for a real deployment, not a substitute for load testing and incident procedures
that match a particular product.

## Supported topology

The reference topology is one API instance, PostgreSQL 17, and a persistent local filesystem
volume mounted at `UPLOAD_ROOT_DIRECTORY`. PostgreSQL is authoritative for metadata and confirmed
offsets. The filesystem contains opaque blob bytes and staging files.

Multiple API processes may share PostgreSQL, but every process must also see the same durable blob
store with the same consistency semantics. The included filesystem adapter does not turn separate
container disks into shared storage. Network filesystems and object-storage adapters have not been
validated by this repository. Use one API replica until a shared adapter has been implemented and
tested against process failure and concurrent append.

Recommended request path:

```text
browser -> TLS reverse proxy -> authenticated API -> PostgreSQL
                                      |
                                      +-----------> persistent upload volume
```

Keep `GET /metrics` and readiness details on a private operations network. Liveness may be exposed
to the orchestrator but should not be used as an internet-facing status page.

## Deployment checklist

1. Provision PostgreSQL and a persistent volume with enough inode and byte capacity.
2. Create a dedicated database role with only the permissions needed by the application schema.
3. Configure the OIDC issuer, audience, JWKS policy, database URL, upload root, public API origin,
   upload limits, retention, cleanup interval, and trusted proxy settings.
4. Mount the upload root at a stable absolute path owned by the unprivileged application user.
5. Run the built API with Node.js 22.12 or newer. Startup runs idempotent schema migrations before
   the listener becomes ready.
6. Wait for readiness before accepting traffic. Do not route requests based on liveness alone.
7. Perform a small upload, a pause/resume cycle, a reload recovery, and a delete through the same
   proxy path used by clients.
8. Confirm that metrics are scraped and that logs reach the incident-search system.

Migrations use PostgreSQL advisory locking so parallel starts serialize schema changes. Deploy a
single instance first when changing schema or storage behavior, observe it, and then roll the
remaining capacity.

## Reverse proxy requirements

Resumable requests rely on HTTP method and header preservation. Configure the proxy to:

- pass `OPTIONS`, `POST`, `HEAD`, `PATCH`, and `DELETE` without method rewriting
- preserve `Tus-Resumable`, `Upload-Offset`, `Upload-Length`, `Upload-Checksum`,
  `Upload-Metadata`, `Location`, and `Authorization`
- disable request buffering for chunk bodies so backpressure reaches the client
- set body limits at or above the application's configured maximum chunk size
- allow enough request time for the slowest supported chunk while retaining an upper bound
- forward the original scheme and host only through a trusted proxy configuration
- use same-origin routing where possible, or explicitly configure CORS for every tus method and
  required request/response header

Do not enable automatic retries for non-idempotent `POST` or `PATCH` requests at the proxy. The
browser client reconciles ambiguous results with `HEAD`; an intermediary retry would obscure which
request wrote bytes.

## Configuration and secrets

Inject secrets through the deployment platform. Do not place tokens, database passwords, signing
keys, or production issuer configuration in images or source control. Rotate database credentials
and OIDC keys using the issuer and platform procedures, then verify readiness and an authenticated
upload.

The demo validates configuration before listening. Treat validation failures as deployment errors
rather than falling back to permissive defaults. Keep production and test databases, issuers,
origins, and upload roots separate.

## Capacity planning

Budget for completed and active blobs, staging chunks, filesystem metadata, PostgreSQL rows,
backups, and temporary headroom. A process can stage multiple chunks concurrently even though one
upload has at most one writer lease. Set application upload and chunk limits below proxy, platform,
and filesystem limits.

Establish normal rates from load tests before setting paging thresholds. These are conservative
initial signals to tune:

- warn when the upload volume reaches 80% capacity and page at 90%
- page when readiness fails continuously for two minutes
- alert on sustained upload `5xx` growth, checksum failures, or lease conflicts above the tested
  baseline
- alert whenever cleanup fails repeatedly or the age of the oldest expired, unpurged upload grows
- investigate event-loop saturation, PostgreSQL pool exhaustion, and long append latency together

Telemetry intentionally uses bounded labels. Correlate individual incidents through request IDs
in access logs, never by adding owner, filename, metadata, token, or upload ID as a metric label.

## Cleanup and retention

Run cleanup in every API process only when all processes share the same blob store. PostgreSQL
`SKIP LOCKED` claims prevent duplicate active cleanup work, and expired tombstones remain available
for protocol-correct `410 Gone` responses.

Choose batch size, concurrency, claim duration, schedule interval, and retention from measured
storage latency. Cleanup must not consume all database connections or disk throughput. A failed
blob deletion is released for a later retry rather than falsely marked complete. See the
[cleanup contract](cleanup-worker.md) for exact crash behavior.

## Backup and restore

PostgreSQL and the filesystem do not participate in one transaction, so independent live backups
may capture different points in time. Prefer a maintenance window that stops new uploads and drains
active requests before taking coordinated database and volume snapshots. If the platform provides
consistent group snapshots, validate their guarantees with a restore exercise.

After restore:

1. keep traffic disabled and run migrations
2. compare database records with blob presence and length
3. treat a blob shorter than PostgreSQL's confirmed offset as corruption
4. allow a later writer to truncate only bytes beyond the confirmed offset
5. run a representative upload and recovery before restoring traffic

Never advance a database offset to match unexplained bytes. PostgreSQL remains the authority for
confirmed progress.

## Graceful shutdown and rollback

On `SIGTERM`, remove the instance from readiness, stop accepting work, drain active requests and the
cleanup run, then close PostgreSQL. The platform grace period must exceed the largest supported
chunk duration plus shutdown headroom. Forced termination remains safe for confirmed offsets, but
clients may need to reconcile and retry.

Prefer fix-forward releases. If rollback is necessary, verify that the older binary understands the
current schema and configuration first. Never move or replace an existing release tag. Roll back
application code without rolling back PostgreSQL or blob data unless a tested restore plan requires
both.

## Incident playbooks

### Readiness is failing

Check database reachability, credentials, pool saturation, migration logs, and PostgreSQL health.
Keep the instance out of traffic. Do not restart-loop healthy PostgreSQL under upload load without
first identifying pool or query pressure.

### Uploads return offset conflicts

Inspect conflict and append latency rates. A client should issue `HEAD`, accept the server's
confirmed offset, and continue. Persistent conflicts can indicate duplicate client tasks, proxy
retries, or a writer whose lease outlives the intended request window.

### Upload volume is nearly full

Stop new upload creation before the filesystem is exhausted, preserve resume and delete access when
safe, and verify cleanup progress. Expand the volume or shorten retention according to product
policy. Do not manually delete opaque blob paths without reconciling PostgreSQL.

### Blob corruption is reported

Remove the affected upload from normal service, preserve database and filesystem evidence, and
compare confirmed offset, actual size, restore history, and storage errors. A short blob cannot be
repaired from metadata. Restore the coordinated data set or have the owner restart the upload.

### Cleanup is stuck

Check the oldest claim time, filesystem errors, permissions, and cleanup latency. Expired claims are
recoverable. Avoid deleting rows to unblock the worker because tombstones and blob reconciliation
would be lost.
