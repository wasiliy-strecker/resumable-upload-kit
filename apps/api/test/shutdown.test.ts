import { EventEmitter } from 'node:events'

import { describe, expect, it, vi } from 'vitest'

import { installShutdownHandlers } from '../src/shutdown.js'

describe('graceful shutdown handlers', () => {
  it('closes exactly once and removes both signal handlers', async () => {
    const signals = new EventEmitter()
    const shutdown = vi.fn(async () => undefined)
    installShutdownHandlers(shutdown, { signalSource: signals })

    signals.emit('SIGTERM')
    signals.emit('SIGINT')
    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce())

    expect(signals.listenerCount('SIGINT')).toBe(0)
    expect(signals.listenerCount('SIGTERM')).toBe(0)
  })

  it('reports shutdown failures and supports explicit disposal', async () => {
    const failingSignals = new EventEmitter()
    const failure = new Error('close failed')
    const onError = vi.fn()
    installShutdownHandlers(
      vi.fn(async () => {
        throw failure
      }),
      { onError, signalSource: failingSignals },
    )
    failingSignals.emit('SIGINT')
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(failure))

    const disposedSignals = new EventEmitter()
    const shutdown = vi.fn(async () => undefined)
    const dispose = installShutdownHandlers(shutdown, { signalSource: disposedSignals })
    dispose()
    disposedSignals.emit('SIGTERM')
    expect(shutdown).not.toHaveBeenCalled()
  })
})
