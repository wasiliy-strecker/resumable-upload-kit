import type { Pool } from 'pg'
import { describe, expect, it, vi } from 'vitest'

import type { ApiConfig } from '../src/config.js'
import { createProductionApi } from '../src/runtime.js'

const config: ApiConfig = {
  audience: 'resumable-upload-api',
  databasePoolSize: 4,
  databaseUrl: 'postgresql://database.example.test/uploads',
  host: '127.0.0.1',
  issuer: 'https://identity.example.test/',
  jwksUrl: 'https://identity.example.test/jwks.json',
  port: 3000,
  uploadDirectory: '/tmp/resumable-upload-kit-runtime-test',
}

describe('production API runtime', () => {
  it('migrates, checks readiness, observes pool failures, and closes the pool', async () => {
    const pool = fakePool()
    const createPool = vi.fn(() => pool.value)
    const migrate = vi.fn(async () => undefined)
    const app = await createProductionApi(config, {
      createPool,
      logger: false,
      migrate,
    })

    expect(createPool).toHaveBeenCalledWith({
      connectionString: config.databaseUrl,
      max: config.databasePoolSize,
    })
    expect(migrate).toHaveBeenCalledWith(pool.value)
    expect(pool.on).toHaveBeenCalledWith('error', expect.any(Function))

    const readiness = await app.inject({ method: 'GET', url: '/health/ready' })
    expect(readiness.statusCode).toBe(200)
    expect(pool.query).toHaveBeenCalledWith('SELECT 1')

    const errorListener = pool.on.mock.calls[0]?.[1]
    errorListener?.(new Error('idle client failed'))
    await app.close()
    expect(pool.end).toHaveBeenCalledOnce()
  })

  it('closes the pool when migrations fail', async () => {
    const pool = fakePool()
    const failure = new Error('migration failed')
    pool.end.mockRejectedValueOnce(new Error('pool close also failed'))

    await expect(
      createProductionApi(config, {
        createPool: () => pool.value,
        logger: false,
        migrate: vi.fn(async () => {
          throw failure
        }),
      }),
    ).rejects.toBe(failure)
    expect(pool.end).toHaveBeenCalledOnce()
  })
})

function fakePool() {
  const end = vi.fn(async () => undefined)
  const on = vi.fn((_event: string, _listener: (error: Error) => void) => undefined)
  const query = vi.fn(async (_sql: string) => ({ rows: [] as never[] }))
  const value = { end, on, query } as unknown as Pool
  return { end, on, query, value }
}
