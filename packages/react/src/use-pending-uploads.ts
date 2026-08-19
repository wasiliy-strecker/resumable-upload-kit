import { useCallback, useEffect, useRef, useState } from 'react'

import type { ResumableUploadClient, UploadCheckpoint } from '@resumable-upload-kit/client'

export interface UsePendingUploadsResult {
  readonly checkpoints: readonly UploadCheckpoint[]
  readonly error: Error | null
  readonly isLoading: boolean
  readonly refresh: () => Promise<readonly UploadCheckpoint[]>
}

interface PendingRequest {
  readonly client: ResumableUploadClient
  readonly promise: Promise<readonly UploadCheckpoint[]>
}

export function usePendingUploads(client: ResumableUploadClient): UsePendingUploadsResult {
  const [checkpoints, setCheckpoints] = useState<readonly UploadCheckpoint[]>([])
  const [error, setError] = useState<Error | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const mountedRef = useRef(false)
  const requestIdRef = useRef(0)
  const inFlightRef = useRef<PendingRequest | null>(null)

  const refresh = useCallback((): Promise<readonly UploadCheckpoint[]> => {
    const inFlight = inFlightRef.current

    if (inFlight?.client === client) {
      return inFlight.promise
    }

    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    setError(null)
    setIsLoading(true)

    const promise = client.list().then(
      (nextCheckpoints) => {
        if (mountedRef.current && requestIdRef.current === requestId) {
          setCheckpoints(nextCheckpoints)
          setIsLoading(false)
        }

        return nextCheckpoints
      },
      (reason: unknown) => {
        const nextError = normalizeError(reason)

        if (mountedRef.current && requestIdRef.current === requestId) {
          setError(nextError)
          setIsLoading(false)
        }

        throw nextError
      },
    )

    inFlightRef.current = { client, promise }
    const clearInFlight = (): void => {
      if (inFlightRef.current?.promise === promise) {
        inFlightRef.current = null
      }
    }
    void promise.then(clearInFlight, clearInFlight)
    return promise
  }, [client])

  useEffect(() => {
    mountedRef.current = true
    void refresh().catch(() => undefined)

    return () => {
      mountedRef.current = false
    }
  }, [refresh])

  return { checkpoints, error, isLoading, refresh }
}

function normalizeError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error('Could not load pending uploads', { cause: error })
}
