import { createProductionApi } from './runtime.js'
import { readApiConfig } from './config.js'
import { installShutdownHandlers } from './shutdown.js'

async function main(): Promise<void> {
  const config = readApiConfig(process.env)
  const app = await createProductionApi(config)
  const removeShutdownHandlers = installShutdownHandlers(() => app.close(), {
    onError: (error) => {
      app.log.error({ err: error }, 'Graceful shutdown failed')
      process.exitCode = 1
    },
  })

  try {
    await app.listen({ host: config.host, port: config.port })
  } catch (error) {
    removeShutdownHandlers()
    await app.close().catch(() => undefined)
    throw error
  }
}

void main().catch((error: unknown) => {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
  process.stderr.write(`API startup failed\n${detail}\n`)
  process.exitCode = 1
})
