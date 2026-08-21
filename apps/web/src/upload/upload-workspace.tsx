import { useMemo, useState, type ChangeEvent, type ReactNode } from 'react'

import {
  createFileUploadSource,
  type ResumableUploadClient,
  type UploadCheckpoint,
  type UploadSource,
} from '@resumable-upload-kit/client'
import { usePendingUploads, useResumableUpload } from '@resumable-upload-kit/react'

import {
  checkpointFilename,
  formatBytes,
  taskStatusLabel,
  uploadErrorMessage,
} from './presentation.js'

export interface UploadWorkspaceProps {
  readonly client: ResumableUploadClient
  readonly createSource?: (file: File) => Promise<UploadSource>
}

export function UploadWorkspace({
  client,
  createSource = createFileUploadSource,
}: UploadWorkspaceProps): ReactNode {
  const upload = useResumableUpload(client)
  const pending = usePendingUploads(client)
  const [selectedFilename, setSelectedFilename] = useState<string | null>(null)
  const [interactionError, setInteractionError] = useState<Error | null>(null)
  const [busyCheckpointId, setBusyCheckpointId] = useState<string | null>(null)
  const visibleCheckpoints = useMemo(
    () => pending.checkpoints.filter((checkpoint) => checkpoint.id !== upload.task?.id),
    [pending.checkpoints, upload.task?.id],
  )
  const visibleError =
    interactionError ?? upload.operationError ?? upload.state?.error ?? pending.error

  const run = async (operation: () => Promise<void>): Promise<void> => {
    setInteractionError(null)

    try {
      await operation()
    } catch (error) {
      setInteractionError(normalizeError(error))
    }
  }

  const createUpload = async (file: File): Promise<void> => {
    await run(async () => {
      setSelectedFilename(file.name)
      const source = await createSource(file)
      await upload.create({
        metadata: [{ key: 'filename', value: new TextEncoder().encode(file.name) }],
        source,
      })
      await upload.start()
      await pending.refresh()
    })
  }

  const resumeCheckpoint = async (checkpoint: UploadCheckpoint, file: File): Promise<void> => {
    setBusyCheckpointId(checkpoint.id)
    setSelectedFilename(checkpointFilename(checkpoint))

    try {
      await run(async () => {
        await upload.resume(checkpoint.id, await createSource(file))
        await upload.start()
        await pending.refresh()
      })
    } finally {
      setBusyCheckpointId(null)
    }
  }

  const terminateCheckpoint = async (checkpointId: string): Promise<void> => {
    setBusyCheckpointId(checkpointId)

    try {
      await run(async () => {
        await client.terminate(checkpointId)
        await pending.refresh()
      })
    } finally {
      setBusyCheckpointId(null)
    }
  }

  const state = upload.state
  const confirmed = state?.confirmedOffset ?? 0
  const total = state?.totalBytes ?? 0
  const percentage = total === 0 ? 0 : Math.floor((confirmed / total) * 100)

  return (
    <main id="main-content" className="workspace">
      <h1 className="visually-hidden">Upload workspace</h1>
      <section className="upload-card" aria-labelledby="new-upload-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">New upload</p>
            <h2 id="new-upload-title">Keep every confirmed byte</h2>
          </div>
          <span className="protocol-badge">tus 1.0</span>
        </div>

        <label className="file-drop">
          <span className="file-drop__title">Choose a file to upload</span>
          <span className="file-drop__hint">
            Checksummed chunks can continue after interruptions
          </span>
          <input
            type="file"
            disabled={upload.operationStatus !== 'idle'}
            onChange={(event) => void onFileSelected(event, createUpload)}
          />
        </label>

        {state ? (
          <div className="active-upload" aria-labelledby="active-upload-title">
            <div className="active-upload__summary">
              <div>
                <p id="active-upload-title" className="filename">
                  {selectedFilename ?? 'Selected upload'}
                </p>
                <p className="status-line" aria-live="polite">
                  {taskStatusLabel(state.status)} · {percentage}%
                </p>
              </div>
              <strong>{formatBytes(confirmed)} confirmed</strong>
            </div>
            <progress
              aria-label={`Upload progress for ${selectedFilename ?? 'selected upload'}`}
              max={Math.max(total, 1)}
              value={total === 0 ? 1 : confirmed}
            >
              {percentage}%
            </progress>
            <div className="upload-meta">
              <span>{formatBytes(total)} total</span>
              {state.attempt > 1 ? <span>Attempt {state.attempt}</span> : null}
            </div>
            <div className="actions">
              {canPause(state.status) ? (
                <button className="button button--secondary" type="button" onClick={upload.pause}>
                  Pause
                </button>
              ) : null}
              {canContinue(state.status) ? (
                <button
                  className="button button--primary"
                  type="button"
                  onClick={() => void run(async () => upload.start().then(() => undefined))}
                >
                  Continue
                </button>
              ) : null}
              {canCancel(state.status) ? (
                <button
                  className="button button--danger"
                  type="button"
                  onClick={() =>
                    void run(async () => {
                      await upload.cancel()
                      await pending.refresh()
                    })
                  }
                >
                  Cancel upload
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {visibleError ? (
          <div className="error-notice" role="alert">
            <strong>Upload needs attention</strong>
            <span>{uploadErrorMessage(visibleError)}</span>
          </div>
        ) : null}
      </section>

      <section className="recovery-card" aria-labelledby="recovery-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Browser recovery</p>
            <h2 id="recovery-title">Saved uploads</h2>
          </div>
          <button
            className="text-button"
            type="button"
            disabled={pending.isLoading}
            onClick={() => void pending.refresh()}
          >
            Refresh
          </button>
        </div>

        {pending.isLoading && visibleCheckpoints.length === 0 ? (
          <p className="empty-state" aria-live="polite">
            Loading saved uploads…
          </p>
        ) : visibleCheckpoints.length === 0 ? (
          <p className="empty-state">No interrupted uploads on this browser.</p>
        ) : (
          <ul className="checkpoint-list">
            {visibleCheckpoints.map((checkpoint) => (
              <li key={checkpoint.id} className="checkpoint">
                <div>
                  <p className="filename">{checkpointFilename(checkpoint)}</p>
                  <p className="checkpoint__meta">
                    {formatBytes(checkpoint.confirmedOffset)} of {formatBytes(checkpoint.size)} ·{' '}
                    {checkpoint.phase}
                  </p>
                  <p className="checkpoint__date">Saved {formatDate(checkpoint.updatedAt)}</p>
                </div>
                <div className="checkpoint__actions">
                  <label className="button button--primary button--file">
                    Select original file
                    <input
                      type="file"
                      disabled={busyCheckpointId !== null}
                      onChange={(event) =>
                        void onFileSelected(event, (file) => resumeCheckpoint(checkpoint, file))
                      }
                    />
                  </label>
                  <button
                    className="text-button text-button--danger"
                    type="button"
                    disabled={busyCheckpointId !== null}
                    onClick={() => void terminateCheckpoint(checkpoint.id)}
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}

async function onFileSelected(
  event: ChangeEvent<HTMLInputElement>,
  action: (file: File) => Promise<void>,
): Promise<void> {
  const file = event.currentTarget.files?.[0]
  event.currentTarget.value = ''
  if (file) await action(file)
}

function canPause(status: string): boolean {
  return ['creating', 'reconciling', 'uploading', 'retrying'].includes(status)
}

function canContinue(status: string): boolean {
  return status === 'paused' || status === 'failed'
}

function canCancel(status: string): boolean {
  return status !== 'completed' && status !== 'canceled'
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
    : 'at an unknown time'
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error('The upload action failed', { cause: error })
}
