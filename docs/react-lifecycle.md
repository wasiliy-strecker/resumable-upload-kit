# React lifecycle contract

`@resumable-upload-kit/react` adapts the framework-independent client to React. It does not own
upload correctness and deliberately avoids hidden lifecycle side effects.

## Subscription semantics

`useUploadTask` reads immutable `UploadTaskState` snapshots with `useSyncExternalStore`. React can
subscribe, unsubscribe, and resubscribe during StrictMode without starting, pausing, or canceling a
task. Replacing a task detaches the old listener before the new task becomes observable. Server
rendering receives the task's current snapshot without installing a subscription.

## Orchestration semantics

`useResumableUpload` selects at most one task for rendering. `create` and `resume` are explicit
async actions. When calls overlap, the latest invocation owns the selection; an older result cannot
replace it merely because it resolves later. All promises still settle normally so applications
that intentionally start concurrent work retain access to every returned task.

`start`, `pause`, and `cancel` delegate to the selected task. `clearTask` only detaches it from the
component. Neither clearing nor unmounting changes the underlying upload. This prevents route
changes and development-only StrictMode cycles from destroying durable work.

## Recovery loading

`usePendingUploads` loads persisted checkpoints on mount and exposes `refresh`. Concurrent reads
for the same client are coalesced, which prevents StrictMode's development effect cycle from
duplicating the IndexedDB query. Results from an obsolete client or an unmounted hook are ignored.

Authorization headers, file bytes, and retry state remain owned by the browser client. React state
contains only references to tasks, immutable task snapshots, checkpoints, and operation errors.
