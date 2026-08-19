import { useCallback, useSyncExternalStore } from 'react'

import type { UploadTask, UploadTaskState } from '@resumable-upload-kit/client'

const emptySnapshot = (): null => null

export function useUploadTask(task: UploadTask | null): UploadTaskState | null {
  const subscribe = useCallback(
    (notify: () => void) => {
      if (task === null) {
        return () => undefined
      }

      return task.subscribe(notify)
    },
    [task],
  )
  const getSnapshot = useCallback(() => task?.state ?? null, [task])

  return useSyncExternalStore(subscribe, getSnapshot, task === null ? emptySnapshot : getSnapshot)
}
