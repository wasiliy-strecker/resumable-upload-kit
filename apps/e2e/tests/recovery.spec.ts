import { mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, test, type BrowserContext, type Page } from '@playwright/test'

import { appOrigin, identityOrigin } from '../src/environment.js'

const fixtureDirectory = fileURLToPath(new URL('../../../test-results/e2e-files/', import.meta.url))
const originalFile = `${fixtureDirectory}recovery.bin`
const wrongFile = `${fixtureDirectory}different.bin`
const fileSize = 5 * 1_024 * 1_024 + 256 * 1_024

test.beforeAll(async () => {
  await mkdir(dirname(originalFile), { recursive: true })
  await writeFile(originalFile, Buffer.alloc(fileSize, 0x61))
  await writeFile(wrongFile, Buffer.alloc(fileSize, 0x62))
  const stableTime = new Date('2026-08-22T08:00:00.000Z')
  await Promise.all([
    utimes(originalFile, stableTime, stableTime),
    utimes(wrongFile, stableTime, stableTime),
  ])
})

test.afterAll(async () => {
  await rm(fixtureDirectory, { force: true, recursive: true })
})

test('reconciles a chunk committed by the server when its response is lost', async ({
  context,
  page,
}) => {
  await signIn(context, page, 'user-alice', 'Alice')
  let droppedResponse = false
  let headRequests = 0
  page.on('request', (request) => {
    if (request.method() === 'HEAD' && request.url().includes('/uploads/')) headRequests += 1
  })
  await page.route('**/uploads/*', async (route) => {
    if (route.request().method() === 'PATCH' && !droppedResponse) {
      droppedResponse = true
      const response = await route.fetch()
      expect(response.status()).toBe(204)
      await route.abort('failed')
      return
    }

    await route.continue()
  })

  await page.getByLabel('Choose a file to upload').setInputFiles(originalFile)

  await expect(page.getByText('Completed · 100%')).toBeVisible()
  await expect(page.getByText('5.3 MB confirmed')).toBeVisible()
  expect(droppedResponse).toBe(true)
  expect(headRequests).toBeGreaterThan(0)
  await expect(page.getByText('No interrupted uploads on this browser.')).toBeVisible()
})

test('recovers after reload, isolates users, and rejects the wrong source', async ({
  context,
  page,
}) => {
  await signIn(context, page, 'user-alice', 'Alice')
  let patchCount = 0
  let releaseSecondPatch: (() => void) | undefined
  const secondPatchReached = new Promise<void>((resolve) => {
    releaseSecondPatch = resolve
  })
  await page.route('**/uploads/*', async (route) => {
    if (route.request().method() === 'PATCH') {
      patchCount += 1
      if (patchCount === 2) {
        releaseSecondPatch?.()
        await route.abort('failed')
        return
      }
    }

    await route.continue()
  })
  await page.getByLabel('Choose a file to upload').setInputFiles(originalFile)
  await secondPatchReached

  await page.reload()
  await page.unrouteAll({ behavior: 'wait' })
  await expect(page.getByText('recovery.bin')).toBeVisible()
  await expect(page.getByText(/5\.0 MB of 5\.3 MB/)).toBeVisible()

  await signOut(page)
  await signIn(context, page, 'user-bob', 'Bob')
  await expect(page.getByText('No interrupted uploads on this browser.')).toBeVisible()

  await signOut(page)
  await signIn(context, page, 'user-alice', 'Alice')
  const checkpoint = page.getByRole('listitem').filter({ hasText: 'recovery.bin' })
  await checkpoint.getByLabel('Select original file').setInputFiles(wrongFile)
  await expect(page.getByRole('alert')).toContainText('does not match the saved upload')

  await checkpoint.getByLabel('Select original file').setInputFiles(originalFile)
  await expect(page.getByText('Completed · 100%')).toBeVisible()
  await expect(page.getByText('No interrupted uploads on this browser.')).toBeVisible()
})

async function signIn(
  context: BrowserContext,
  page: Page,
  subject: 'user-alice' | 'user-bob',
  displayName: string,
): Promise<void> {
  await context.addCookies([
    {
      httpOnly: true,
      name: 'e2e-subject',
      sameSite: 'Lax',
      url: identityOrigin,
      value: subject,
    },
  ])
  await page.goto('/')
  await page.getByRole('button', { name: /Sign in with your identity provider/i }).click()
  await expect(page).toHaveURL(`${appOrigin}/`)
  await expect(page.getByText('Signed in as')).toBeVisible()
  await expect(page.getByText(displayName, { exact: true })).toBeVisible()
}

async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(
    page.getByRole('button', { name: /Sign in with your identity provider/i }),
  ).toBeVisible()
}
