// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import axe from 'axe-core'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  UploadClientError,
  type CreateUploadTaskInput,
  type ResumableUploadClient,
  type UploadCheckpoint,
  type UploadSource,
  type UploadTask,
  type UploadTaskListener,
  type UploadTaskState,
} from '@resumable-upload-kit/client'

import { UploadWorkspace } from '../src/upload/upload-workspace.js'

const source: UploadSource = {
  fingerprint: 'source-fingerprint',
  size: 12,
  slice: () => new Blob(),
}

afterEach(cleanup)

describe('UploadWorkspace', () => {
  it('is accessible and controls a new upload through explicit user actions', async () => {
    const user = userEvent.setup()
    const task = new FakeTask('new-task')
    const create = vi.fn(async () => task)
    const list = vi.fn(async () => [])
    const client = fakeClient({ create, list })
    const createSource = vi.fn(async () => source)
    const { container } = render(<UploadWorkspace client={client} createSource={createSource} />)
    await waitFor(() => expect(list).toHaveBeenCalled())

    const accessibility = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } },
    })
    expect(accessibility.violations).toEqual([])

    const file = new File(['hello world!'], 'report.pdf', { type: 'application/pdf' })
    await user.upload(screen.getByLabelText(/Choose a file to upload/i), file)
    await waitFor(() => expect(task.start).toHaveBeenCalledOnce())

    expect(createSource).toHaveBeenCalledWith(file)
    expect(create).toHaveBeenCalledWith({
      metadata: [{ key: 'filename', value: new TextEncoder().encode('report.pdf') }],
      source,
    })
    expect(screen.getByText('Uploading · 25%')).toBeTruthy()
    expect(screen.getByRole('progressbar').getAttribute('value')).toBe('3')

    await user.click(screen.getByRole('button', { name: 'Pause' }))
    expect(screen.getByText('Paused · 25%')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(task.start).toHaveBeenCalledTimes(2))
    await user.click(screen.getByRole('button', { name: 'Cancel upload' }))
    await waitFor(() => expect(task.cancel).toHaveBeenCalledOnce())
    expect(screen.getByText('Canceled · 25%')).toBeTruthy()
  })

  it('lists recoverable checkpoints, explains source mismatch, and removes stale entries', async () => {
    const user = userEvent.setup()
    const saved = checkpoint()
    const mismatch = new UploadClientError({
      code: 'source_mismatch',
      message: 'fingerprint mismatch',
    })
    const resume = vi.fn<ResumableUploadClient['resume']>()
    resume.mockRejectedValueOnce(mismatch)
    const terminate = vi.fn(async () => undefined)
    const client = fakeClient({ list: vi.fn(async () => [saved]), resume, terminate })
    const createSource = vi.fn(async () => source)
    render(<UploadWorkspace client={client} createSource={createSource} />)

    await screen.findByText('archive.zip')
    expect(screen.getByText(/3 B of 12 B/)).toBeTruthy()
    await user.upload(
      screen.getByLabelText('Select original file'),
      new File(['wrong'], 'archive.zip'),
    )
    expect((await screen.findByRole('alert')).textContent).toContain('does not match')

    await user.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(terminate).toHaveBeenCalledWith('saved-task'))
  })

  it('resumes a matching checkpoint and excludes the selected task from the saved list', async () => {
    const user = userEvent.setup()
    const saved = checkpoint()
    const task = new FakeTask('saved-task')
    const resume = vi.fn(async () => task)
    const client = fakeClient({ list: vi.fn(async () => [saved]), resume })
    render(<UploadWorkspace client={client} createSource={vi.fn(async () => source)} />)

    await user.upload(
      await screen.findByLabelText('Select original file'),
      new File(['matching'], 'archive.zip'),
    )
    await waitFor(() => expect(task.start).toHaveBeenCalledOnce())
    expect(resume).toHaveBeenCalledWith('saved-task', source)
    expect(screen.queryByText(/3 B of 12 B/)).toBeNull()
  })

  it('normalizes unexpected file preparation failures', async () => {
    const user = userEvent.setup()
    const client = fakeClient()
    const createSource = vi.fn<(file: File) => Promise<UploadSource>>()
    createSource.mockRejectedValueOnce('crypto unavailable')
    render(<UploadWorkspace client={client} createSource={createSource} />)

    await user.upload(screen.getByLabelText(/Choose a file/i), new File(['x'], 'x.txt'))
    expect((await screen.findByRole('alert')).textContent).toContain('upload action failed')
  })
})

class FakeTask implements UploadTask {
  readonly cancel = vi.fn(async () => {
    this.emit({ status: 'canceled' })
  })
  readonly pause = vi.fn(() => this.emit({ status: 'paused' }))
  readonly start = vi.fn(async () => {
    this.emit({ attempt: this.state.attempt + 1, confirmedOffset: 3, status: 'uploading' })
    return this.state
  })
  readonly #listeners = new Set<UploadTaskListener>()
  #state: UploadTaskState

  constructor(readonly id: string) {
    this.#state = {
      attempt: 0,
      confirmedOffset: 0,
      error: null,
      id,
      status: 'paused',
      totalBytes: 12,
      uploadUrl: `/uploads/${id}`,
    }
  }

  get state(): UploadTaskState {
    return this.#state
  }

  subscribe(listener: UploadTaskListener): () => void {
    this.#listeners.add(listener)
    listener(this.#state)
    return () => this.#listeners.delete(listener)
  }

  private emit(update: Partial<UploadTaskState>): void {
    this.#state = { ...this.#state, ...update }
    this.#listeners.forEach((listener) => listener(this.#state))
  }
}

function fakeClient(overrides: Partial<ResumableUploadClient> = {}): ResumableUploadClient {
  return {
    create: vi.fn(async (_input: CreateUploadTaskInput) => new FakeTask('new-task')),
    list: vi.fn(async () => []),
    resume: vi.fn(async (id: string) => new FakeTask(id)),
    terminate: vi.fn(async () => undefined),
    ...overrides,
  }
}

function checkpoint(): UploadCheckpoint {
  return {
    confirmedOffset: 3,
    createdAt: '2026-08-21T08:00:00.000Z',
    expiresAt: '2026-08-22T08:00:00.000Z',
    id: 'saved-task',
    lastErrorCode: null,
    metadata: [{ key: 'filename', value: new TextEncoder().encode('archive.zip') }],
    phase: 'paused',
    size: 12,
    sourceFingerprint: source.fingerprint,
    updatedAt: '2026-08-21T08:30:00.000Z',
    uploadUrl: '/uploads/saved-task',
  }
}
