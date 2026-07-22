import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page, type Route } from '@playwright/test'

const TOKEN = 'a'.repeat(32)
const secretState = { configured: false, editable: true, source: 'missing' }

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

async function mockDashboardApi(page: Page) {
  await page.route('**/api/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname === '/api/bootstrap/status') {
      await json(route, { required: false, available: true })
      return
    }
    const authorized = request.headers().authorization === `Bearer ${TOKEN}`
    if (url.pathname === '/api/status' && !authorized) {
      await json(route, { error: 'Authentication required.' }, 401)
      return
    }
    if (!authorized) {
      await json(route, { error: 'Authentication required.' }, 401)
      return
    }
    if (url.pathname === '/api/status') {
      await json(route, {
        isRunning: false,
        connectionState: 'disconnected',
        totalForwardedCount: 0,
        processedSinceRestart: 0,
        forwardingEnabled: true,
        forwardXmlToTarget: false,
        queue: { running: 0, queued: 0, maxConcurrency: 2, paused: false },
        telegramLogin: { state: 'idle' },
      })
      return
    }
    if (url.pathname === '/api/config') {
      await json(route, { apiId: 0, sourceChannels: [], targetChannel: '', xmlParsing: { enabled: false } })
      return
    }
    if (url.pathname === '/api/secrets') {
      await json(route, {
        secrets: {
          telegramApiHash: secretState,
          openRouterApiKey: secretState,
          dashboardAdminToken: { configured: true, editable: true, source: 'managed' },
          dashboardViewerToken: secretState,
          auditWebhookToken: secretState,
          backupOffsiteToken: secretState,
          backupEncryptionKey: secretState,
        },
      })
      return
    }
    if (url.pathname === '/api/recovery') {
      await json(route, { active: false })
      return
    }
    if (url.pathname === '/api/metrics-history') {
      await json(route, { history: [] })
      return
    }
    await json(route, {})
  })
}

test('keyboard authentication unlocks the responsive dashboard without WCAG A/AA violations', async ({ page }) => {
  await mockDashboardApi(page)
  await page.goto('/')

  await expect(page.getByRole('heading', { name: 'Dashboard authentication' })).toBeVisible()
  const token = page.getByLabel('Bearer token')
  await token.fill(TOKEN)
  await token.press('Enter')

  await expect(page.getByRole('heading', { name: 'Executive Trading & Operations' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  expect(results.violations).toEqual([])
})
