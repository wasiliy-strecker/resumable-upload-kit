import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      exclude: ['**/dist/**', '**/index.ts', '**/*.config.ts'],
      include: ['packages/*/src/**/*.ts'],
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      thresholds: {
        branches: 90,
        functions: 95,
        lines: 95,
        statements: 95,
      },
    },
    include: ['packages/**/*.test.ts'],
    exclude: ['**/dist/**', '**/node_modules/**'],
  },
})
