export type ShutdownSignal = 'SIGINT' | 'SIGTERM'

export interface ShutdownSignalSource {
  off(signal: ShutdownSignal, listener: () => void): unknown
  once(signal: ShutdownSignal, listener: () => void): unknown
}

export interface InstallShutdownHandlersOptions {
  readonly onError?: (error: unknown) => void
  readonly signalSource?: ShutdownSignalSource
}

export function installShutdownHandlers(
  shutdown: () => Promise<void>,
  options: InstallShutdownHandlersOptions = {},
): () => void {
  const signalSource = options.signalSource ?? process
  let shuttingDown = false

  const removeHandlers = (): void => {
    signalSource.off('SIGINT', handleSignal)
    signalSource.off('SIGTERM', handleSignal)
  }
  const handleSignal = (): void => {
    if (shuttingDown) {
      return
    }

    shuttingDown = true
    removeHandlers()
    void shutdown().catch((error: unknown) => options.onError?.(error))
  }

  signalSource.once('SIGINT', handleSignal)
  signalSource.once('SIGTERM', handleSignal)
  return removeHandlers
}
