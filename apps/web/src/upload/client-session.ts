import {
  IndexedDbUploadCheckpointStore,
  UploadClientError,
  createResumableUploadClient,
  type CreateResumableUploadClientOptions,
  type ResumableUploadClient,
  type UploadCheckpointStore,
} from '@resumable-upload-kit/client'

export interface UploadClientSession {
  readonly client: ResumableUploadClient
  retain(): () => void
}

interface CreateUploadClientSessionOptions {
  readonly createClient?: (options: CreateResumableUploadClientOptions) => ResumableUploadClient
  readonly createStore?: (databaseName: string) => ClosableCheckpointStore
  readonly getAccessToken: () => string | null
  readonly subject: string
  readonly uploadEndpoint: string
}

interface ClosableCheckpointStore extends UploadCheckpointStore {
  close(): void
}

export function createUploadClientSession(
  options: CreateUploadClientSessionOptions,
): UploadClientSession {
  const store = (
    options.createStore ?? ((databaseName) => new IndexedDbUploadCheckpointStore({ databaseName }))
  )(checkpointDatabaseName(options.subject))
  const client = (options.createClient ?? createResumableUploadClient)({
    checkpointStore: store,
    endpoint: options.uploadEndpoint,
    resolveHeaders: () => {
      const accessToken = options.getAccessToken()

      if (accessToken === null) {
        throw new UploadClientError({
          code: 'authentication_failed',
          message: 'Your sign-in session is no longer available',
          status: 401,
        })
      }

      return { Authorization: `Bearer ${accessToken}` }
    },
  })

  let activeConsumers = 0
  let closed = false
  let lifecycleVersion = 0

  return {
    client,
    retain(): () => void {
      if (closed) throw new Error('Upload client session is already closed')
      activeConsumers += 1
      lifecycleVersion += 1
      let released = false

      return () => {
        if (released) return
        released = true
        activeConsumers -= 1
        lifecycleVersion += 1
        const releaseVersion = lifecycleVersion

        queueMicrotask(() => {
          if (!closed && activeConsumers === 0 && lifecycleVersion === releaseVersion) {
            closed = true
            store.close()
          }
        })
      }
    },
  }
}

function checkpointDatabaseName(subject: string): string {
  return `resumable-upload-kit:${encodeURIComponent(subject)}`
}
