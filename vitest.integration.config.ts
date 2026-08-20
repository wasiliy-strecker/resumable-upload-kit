import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: [
      {
        find: '@resumable-upload-kit/client',
        replacement: new URL('./packages/client/src/index.ts', import.meta.url).pathname,
      },
      {
        find: '@resumable-upload-kit/server/fastify',
        replacement: new URL('./packages/server/src/fastify.ts', import.meta.url).pathname,
      },
      {
        find: '@resumable-upload-kit/storage-postgres-filesystem',
        replacement: new URL('./packages/storage-postgres-filesystem/src/index.ts', import.meta.url)
          .pathname,
      },
      {
        find: '@resumable-upload-kit/protocol',
        replacement: new URL('./packages/protocol/src/index.ts', import.meta.url).pathname,
      },
      {
        find: '@resumable-upload-kit/server',
        replacement: new URL('./packages/server/src/index.ts', import.meta.url).pathname,
      },
    ],
  },
  test: {
    fileParallelism: false,
    include: ['apps/**/*.integration.test.ts', 'packages/**/*.integration.test.ts'],
    testTimeout: 15_000,
  },
})
