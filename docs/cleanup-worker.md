# Cleanup worker contract

Incomplete uploads consume filesystem space after their protocol lifetime ends. The cleanup worker
reclaims those bytes without weakening ownership responses or racing an active writer.

## Eligibility and retention

The PostgreSQL adapter can claim active uploads whose `expires_at` is in the past and whose writer
lease is absent or expired. Already expired and terminated tombstones remain eligible until their
blob purge is recorded. Completed uploads are deliberately retained; defining completed-object
retention is an application policy outside this worker.

Cleanup removes only the opaque filesystem blob. The PostgreSQL row remains, including its expired
or terminated status, so an owner still receives the stable `410 Gone` response. Unknown and
foreign identifiers continue to receive `404`.

## Concurrency and recovery

Each run atomically selects a bounded batch with `FOR UPDATE SKIP LOCKED`, transitions eligible
active rows to expired, and assigns one expiring cleanup claim. Multiple processes can run workers
against the same database without receiving the same live claim. Blob deletion is also bounded
inside each process.

Successful deletion is followed by setting `purged_at` under the same claim identifier. Failure
paths are intentionally at-least-once:

- if deletion fails, the worker releases the claim for a later retry
- if a process dies with a claim, another worker can take it after claim expiry
- if the blob is deleted but the database update fails, the next run repeats the idempotent delete
- a lost or superseded claim cannot record another worker's work as complete

The worker does not promise a transaction across PostgreSQL and the filesystem. Its guarantee is
eventual, retryable deletion with durable coordination and an idempotent side effect.

## Scheduling and shutdown

The exported scheduler runs immediately, waits for completion, and only then waits for the next
interval. This prevents overlap within one Node.js process. The demo API reports non-empty run
summaries through its structured logger and reports top-level run failures separately. Graceful
shutdown cancels the next timer, waits for the active run, and then drains PostgreSQL.

Database availability remains part of API readiness. An individual cleanup failure does not make
upload traffic unready because expired blobs can be retried without affecting confirmed upload
offsets.
