import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: [
      {
        find: '@resumable-upload-kit/client',
        replacement: new URL('./packages/client/src/index.ts', import.meta.url).pathname,
      },
      {
        find: '@resumable-upload-kit/react',
        replacement: new URL('./packages/react/src/index.ts', import.meta.url).pathname,
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
    coverage: {
      exclude: [
        'apps/e2e/**',
        '**/dist/**',
        '**/index.ts',
        '**/main.{ts,tsx}',
        '**/*.config.ts',
        '**/postgres-repository.ts',
        '**/postgres-schema.ts',
      ],
      include: ['apps/*/src/**/*.{ts,tsx}', 'packages/*/src/**/*.ts'],
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      thresholds: {
        branches: 90,
        functions: 95,
        lines: 95,
        statements: 95,
      },
    },
    include: ['apps/**/*.test.{ts,tsx}', 'packages/**/*.test.{ts,tsx}'],
    exclude: ['**/dist/**', '**/node_modules/**', '**/*.integration.test.ts'],
  },
})
