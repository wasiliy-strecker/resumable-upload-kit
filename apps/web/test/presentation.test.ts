import { describe, expect, it } from 'vitest'

import {
  UploadClientError,
  type UploadCheckpoint,
  type UploadClientErrorCode,
  type UploadTaskStatus,
} from '@resumable-upload-kit/client'

import {
  checkpointFilename,
  formatBytes,
  taskStatusLabel,
  uploadErrorMessage,
} from '../src/upload/presentation.js'

describe('upload presentation', () => {
  it('formats task states and byte counts', () => {
    const statuses: UploadTaskStatus[] = [
      'creating',
      'reconciling',
      'uploading',
      'retrying',
      'paused',
      'completed',
      'failed',
      'canceled',
    ]

    expect(statuses.map(taskStatusLabel)).toEqual([
      'Creating secure upload',
      'Checking confirmed bytes',
      'Uploading',
      'Retrying after a temporary failure',
      'Paused',
      'Completed',
      'Needs attention',
      'Canceled',
    ])
    expect([42, 1_536, 2_621_440].map(formatBytes)).toEqual(['42 B', '1.5 KB', '2.5 MB'])
  })

  it('extracts safe filenames and falls back for missing or malformed metadata', () => {
    expect(
      checkpointFilename(
        checkpoint([{ key: 'filename', value: new TextEncoder().encode('report.pdf') }]),
      ),
    ).toBe('report.pdf')
    expect(checkpointFilename(checkpoint([]))).toBe('Unnamed file')
    expect(
      checkpointFilename(checkpoint([{ key: 'filename', value: new Uint8Array([255]) }])),
    ).toBe('Unnamed file')
    expect(
      checkpointFilename(checkpoint([{ key: 'filename', value: new TextEncoder().encode('   ') }])),
    ).toBe('Unnamed file')
  })

  it('maps every client failure to actionable copy and preserves unknown errors', () => {
    const codes: UploadClientErrorCode[] = [
      'authentication_failed',
      'checkpoint_not_found',
      'creation_ambiguous',
      'invalid_checkpoint',
      'invalid_response',
      'network_error',
      'protocol_error',
      'remote_not_found',
      'retry_exhausted',
      'source_mismatch',
      'upload_expired',
    ]
    const messages = codes.map((code) =>
      uploadErrorMessage(new UploadClientError({ code, message: code })),
    )

    expect(messages.every((message) => message.length > 20)).toBe(true)
    expect(messages[codes.indexOf('source_mismatch')]).toContain('original file')
    expect(uploadErrorMessage(new Error('custom error'))).toBe('custom error')
    expect(uploadErrorMessage('failure')).toBe('The upload failed unexpectedly')
  })
})

function checkpoint(metadata: UploadCheckpoint['metadata']): UploadCheckpoint {
  return {
    confirmedOffset: 0,
    createdAt: '2026-08-21T08:00:00.000Z',
    expiresAt: null,
    id: 'saved',
    lastErrorCode: null,
    metadata,
    phase: 'paused',
    size: 10,
    sourceFingerprint: 'source',
    updatedAt: '2026-08-21T08:00:00.000Z',
    uploadUrl: '/uploads/saved',
  }
}
