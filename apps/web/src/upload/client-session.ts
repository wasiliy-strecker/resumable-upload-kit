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
  close(): void
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

  return { client, close: () => store.close() }
}

function checkpointDatabaseName(subject: string): string {
  return `resumable-upload-kit:${encodeURIComponent(subject)}`
}
