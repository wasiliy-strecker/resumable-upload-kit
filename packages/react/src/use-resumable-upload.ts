import { useCallback, useEffect, useRef, useState } from 'react'

import type {
  CreateUploadTaskInput,
  ResumableUploadClient,
  UploadSource,
  UploadTask,
  UploadTaskState,
} from '@resumable-upload-kit/client'

import { useUploadTask } from './use-upload-task.js'

export type UploadOperationStatus = 'idle' | 'creating' | 'resuming'

export interface UseResumableUploadResult {
  readonly cancel: () => Promise<void>
  readonly clearTask: () => void
  readonly create: (input: CreateUploadTaskInput) => Promise<UploadTask>
  readonly operationError: Error | null
  readonly operationStatus: UploadOperationStatus
  readonly pause: () => void
  readonly resume: (checkpointId: string, source: UploadSource) => Promise<UploadTask>
  readonly start: () => Promise<UploadTaskState>
  readonly state: UploadTaskState | null
  readonly task: UploadTask | null
}

export function useResumableUpload(client: ResumableUploadClient): UseResumableUploadResult {
  const [task, setTask] = useState<UploadTask | null>(null)
  const [operationStatus, setOperationStatus] = useState<UploadOperationStatus>('idle')
  const [operationError, setOperationError] = useState<Error | null>(null)
  const taskRef = useRef<UploadTask | null>(null)
  const operationIdRef = useRef(0)
  const mountedRef = useRef(false)
  const clientRef = useRef(client)
  clientRef.current = client

  useEffect(() => {
    mountedRef.current = true

    return () => {
      mountedRef.current = false
      operationIdRef.current += 1
    }
  }, [])

  useEffect(() => {
    operationIdRef.current += 1
    taskRef.current = null
    setTask(null)
    setOperationError(null)
    setOperationStatus('idle')
  }, [client])

  const adoptTask = useCallback(
    (nextTask: UploadTask, operationId: number, operationClient: ResumableUploadClient) => {
      if (
        mountedRef.current &&
        operationIdRef.current === operationId &&
        clientRef.current === operationClient
      ) {
        taskRef.current = nextTask
        setTask(nextTask)
        setOperationStatus('idle')
      }
    },
    [],
  )

  const failOperation = useCallback(
    (error: unknown, operationId: number, operationClient: ResumableUploadClient) => {
      const normalizedError = normalizeError(error)

      if (
        mountedRef.current &&
        operationIdRef.current === operationId &&
        clientRef.current === operationClient
      ) {
        setOperationError(normalizedError)
        setOperationStatus('idle')
      }

      return normalizedError
    },
    [],
  )

  const create = useCallback(
    async (input: CreateUploadTaskInput): Promise<UploadTask> => {
      const operationId = operationIdRef.current + 1
      operationIdRef.current = operationId
      setOperationError(null)
      setOperationStatus('creating')

      try {
        const nextTask = await client.create(input)
        adoptTask(nextTask, operationId, client)
        return nextTask
      } catch (error) {
        throw failOperation(error, operationId, client)
      }
    },
    [adoptTask, client, failOperation],
  )

  const resume = useCallback(
    async (checkpointId: string, source: UploadSource): Promise<UploadTask> => {
      const operationId = operationIdRef.current + 1
      operationIdRef.current = operationId
      setOperationError(null)
      setOperationStatus('resuming')

      try {
        const nextTask = await client.resume(checkpointId, source)
        adoptTask(nextTask, operationId, client)
        return nextTask
      } catch (error) {
        throw failOperation(error, operationId, client)
      }
    },
    [adoptTask, client, failOperation],
  )

  const start = useCallback(async (): Promise<UploadTaskState> => {
    return requireTask(taskRef.current).start()
  }, [])

  const pause = useCallback((): void => {
    requireTask(taskRef.current).pause()
  }, [])

  const cancel = useCallback(async (): Promise<void> => {
    await requireTask(taskRef.current).cancel()
  }, [])

  const clearTask = useCallback((): void => {
    operationIdRef.current += 1
    taskRef.current = null
    setTask(null)
    setOperationError(null)
    setOperationStatus('idle')
  }, [])

  return {
    cancel,
    clearTask,
    create,
    operationError,
    operationStatus,
    pause,
    resume,
    start,
    state: useUploadTask(task),
    task,
  }
}

function requireTask(task: UploadTask | null): UploadTask {
  if (task === null) {
    throw new Error('No upload task is currently selected')
  }

  return task
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error('The upload operation failed', { cause: error })
}
