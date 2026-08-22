import { defineConfig, devices } from '@playwright/test'

import { appOrigin, clientId, identityOrigin } from './src/environment.js'

export default defineConfig({
  expect: { timeout: 15_000 },
  forbidOnly: Boolean(process.env.CI),
  fullyParallel: false,
  globalSetup: './src/global-setup.ts',
  outputDir: '../../test-results',
  reporter: process.env.CI
    ? [['line'], ['html', { open: 'never', outputFolder: '../../playwright-report' }]]
    : 'list',
  retries: process.env.CI ? 1 : 0,
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  timeout: 60_000,
  use: {
    ...devices['Desktop Chrome'],
    baseURL: appOrigin,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm --filter resumable-upload-kit-web dev --host 127.0.0.1 --port 5173 --strictPort',
    env: {
      API_PROXY_TARGET: 'http://127.0.0.1:3000',
      VITE_OIDC_AUTHORITY: identityOrigin,
      VITE_OIDC_CLIENT_ID: clientId,
      VITE_OIDC_SCOPE: 'openid profile',
      VITE_UPLOAD_ENDPOINT: '/uploads',
    },
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    url: appOrigin,
  },
  workers: 1,
})
