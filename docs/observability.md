# Observability contract

The server package emits provider-neutral telemetry while the demo API owns the Prometheus adapter.
This keeps metrics dependencies outside the reusable upload state machine and gives other hosts the
option to map the same events to OpenTelemetry or another backend.

## Prometheus surface

The demo API exposes these application metrics:

| Metric                                        | Type      | Bounded labels         |
| --------------------------------------------- | --------- | ---------------------- |
| `resumable_upload_operations_total`           | counter   | `operation`, `outcome` |
| `resumable_upload_operation_duration_seconds` | histogram | `operation`, `outcome` |
| `resumable_upload_errors_total`               | counter   | `operation`, `code`    |
| `resumable_upload_lifecycle_total`            | counter   | `event`                |
| `resumable_upload_confirmed_bytes_total`      | counter   | none                   |
| `resumable_upload_cleanup_runs_total`         | counter   | `outcome`              |
| `resumable_upload_cleanup_duration_seconds`   | histogram | `outcome`              |
| `resumable_upload_cleanup_uploads_total`      | counter   | `result`               |

Operation values are limited to create, head, append, and terminate. Outcomes and protocol error
codes are closed TypeScript unions. Cleanup outcomes distinguish success, partial per-blob failure,
and a top-level run error. Histograms use monotonic elapsed time and seconds at the Prometheus
boundary. The registry also includes prefixed Node.js process metrics.

No metric or label contains an owner, upload ID, filename, metadata value, access token, request
path parameter, stack trace, or raw error message. This avoids both sensitive-data exposure and
unbounded time-series cardinality.

## Scraping

The endpoint is designed for a private operations network:

```yaml
scrape_configs:
  - job_name: resumable-upload-api
    metrics_path: /metrics
    static_configs:
      - targets: ['api:3000']
```

The application does not authenticate Prometheus itself. Production ingress should deny public
access to `/metrics` and allow only the monitoring network or enforce infrastructure-level
authentication. Metrics responses use `Cache-Control: no-store`. A collector failure returns a
sanitized `503` and does not affect upload readiness.

## Interpretation limits

Confirmed bytes count successful chunk commits, not bytes merely read from a request socket.
Lifecycle counters describe transitions observed by the current process and are not a database
inventory. Process restarts reset in-memory application counters; Prometheus is responsible for
scrape retention. Cleanup failures are retryable and should be evaluated together with later
successful runs rather than treated as permanent data loss.
