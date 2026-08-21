import {
  UploadClientError,
  type UploadCheckpoint,
  type UploadTaskStatus,
} from '@resumable-upload-kit/client'

const statusLabels: Readonly<Record<UploadTaskStatus, string>> = {
  canceled: 'Canceled',
  completed: 'Completed',
  creating: 'Creating secure upload',
  failed: 'Needs attention',
  paused: 'Paused',
  reconciling: 'Checking confirmed bytes',
  retrying: 'Retrying after a temporary failure',
  uploading: 'Uploading',
}

export function taskStatusLabel(status: UploadTaskStatus): string {
  return statusLabels[status]
}

export function checkpointFilename(checkpoint: UploadCheckpoint): string {
  const filename = checkpoint.metadata.find((entry) => entry.key === 'filename')

  if (!filename) {
    return 'Unnamed file'
  }

  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(filename.value)
    return decoded.trim().length > 0 ? decoded : 'Unnamed file'
  } catch {
    return 'Unnamed file'
  }
}

export function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)} KB`
  return `${(value / (1_024 * 1_024)).toFixed(1)} MB`
}

export function uploadErrorMessage(error: unknown): string {
  if (!(error instanceof UploadClientError)) {
    return error instanceof Error ? error.message : 'The upload failed unexpectedly'
  }

  switch (error.code) {
    case 'authentication_failed':
      return 'Your session expired. Sign in again to continue this upload.'
    case 'source_mismatch':
      return 'That file does not match the saved upload. Select the original file.'
    case 'checkpoint_not_found':
    case 'remote_not_found':
      return 'This saved upload no longer exists.'
    case 'upload_expired':
      return 'This upload expired on the server. Start a new upload.'
    case 'creation_ambiguous':
      return 'The server may have created the upload. Remove this checkpoint after verifying it.'
    case 'network_error':
    case 'retry_exhausted':
      return 'The network is still unavailable. Your confirmed progress remains saved.'
    case 'invalid_checkpoint':
    case 'invalid_response':
    case 'protocol_error':
      return 'The upload could not continue safely. Review the saved checkpoint before removing it.'
  }
}
