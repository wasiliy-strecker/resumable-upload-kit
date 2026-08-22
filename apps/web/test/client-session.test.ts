import { describe, expect, it, vi } from 'vitest'

import type {
  CreateResumableUploadClientOptions,
  ResumableUploadClient,
} from '@resumable-upload-kit/client'

import { createUploadClientSession } from '../src/upload/client-session.js'

describe('authenticated upload client session', () => {
  it('isolates checkpoints by subject and resolves the latest token for every request', async () => {
    let token: string | null = 'token-one'
    let databaseName = ''
    const store = fakeStore()
    const client = fakeClient()
    const createClient = vi.fn((options: CreateResumableUploadClientOptions) => {
      void options
      return client
    })
    const session = createUploadClientSession({
      createClient,
      createStore: (name) => {
        databaseName = name
        return store
      },
      getAccessToken: () => token,
      subject: 'tenant/alice@example.test',
      uploadEndpoint: '/uploads',
    })

    expect(databaseName).toBe('resumable-upload-kit:tenant%2Falice%40example.test')
    const clientOptions = createClient.mock.calls[0]?.[0]
    if (!clientOptions) throw new Error('upload client was not created')
    expect(clientOptions).toMatchObject({ checkpointStore: store, endpoint: '/uploads' })
    const resolveHeaders = clientOptions.resolveHeaders
    if (!resolveHeaders) throw new Error('resolveHeaders was not configured')
    await expect(Promise.resolve(resolveHeaders())).resolves.toEqual({
      Authorization: 'Bearer token-one',
    })
    token = 'token-two'
    await expect(Promise.resolve(resolveHeaders())).resolves.toEqual({
      Authorization: 'Bearer token-two',
    })
    token = null
    expect(() => resolveHeaders()).toThrow('no longer available')

    const release = session.retain()
    release()
    const strictModeReactivation = session.retain()
    await Promise.resolve()
    expect(store.close).not.toHaveBeenCalled()
    strictModeReactivation()
    strictModeReactivation()
    await Promise.resolve()
    expect(store.close).toHaveBeenCalledOnce()
    expect(() => session.retain()).toThrow('already closed')
    expect(session.client).toBe(client)
  })
})

function fakeStore() {
  return {
    close: vi.fn<() => void>(() => undefined),
    delete: vi.fn(async () => undefined),
    get: vi.fn(async () => null),
    list: vi.fn(async () => []),
    put: vi.fn(async () => undefined),
  }
}

function fakeClient(): ResumableUploadClient {
  return {
    create: vi.fn(),
    list: vi.fn(async () => []),
    resume: vi.fn(),
    terminate: vi.fn(async () => undefined),
  }
}
