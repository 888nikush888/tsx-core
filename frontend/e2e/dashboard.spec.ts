import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page, type Route } from '@playwright/test'

const TOKEN = 'a'.repeat(32)
const secretState = { configured: false, editable: true, source: 'missing' }

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

async function mockDashboardApi(page: Page, firstRun = false) {
  await page.route('**/api/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname === '/api/bootstrap/status') {
      await json(route, {
        required: firstRun,
        available: true,
        localSessionAvailable: true,
      })
      return
    }
    if (url.pathname === '/api/local-session') {
      await json(route, {
        token: TOKEN,
        role: 'admin',
        localStartup: true,
        generatedAdminToken: firstRun,
        expiresInSeconds: firstRun ? undefined : 43_200,
      }, 201)
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

test('local startup unlocks the responsive dashboard without a bearer prompt or WCAG A/AA violations', async ({ page }) => {
  await mockDashboardApi(page)
  await page.goto('/')

  await expect(page.getByRole('heading', { name: 'Live-Cockpit' })).toBeVisible()
  await expect(page.getByLabel('Bearer token')).toHaveCount(0)
  if ((page.viewportSize()?.width ?? 0) < 768) {
    await page.locator('[data-sidebar="trigger"]').click()
  }
  await expect(page.getByRole('link', { name: 'Trading' })).toHaveAttribute('href', '/dashboard?tab=trading')
  await expect(page.getByRole('link', { name: 'XML-Verträge' })).toHaveCount(0)
  const overflowingElements = await page.locator('body *').evaluateAll(elements => {
    const viewportWidth = document.documentElement.clientWidth
    if (document.documentElement.scrollWidth <= viewportWidth) return []
    return elements
      .filter(element => element.getBoundingClientRect().right > viewportWidth + 1)
      .slice(0, 10)
      .map(element => ({
        tag: element.tagName.toLowerCase(),
        className: element.getAttribute('class'),
        text: element.textContent?.trim().slice(0, 80),
        right: Math.round(element.getBoundingClientRect().right),
        viewportWidth,
      }))
  })
  expect(overflowingElements).toEqual([])
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  expect(results.violations).toEqual([])
})

test('first local startup generates and displays the administrator recovery token automatically', async ({ page }) => {
  await mockDashboardApi(page, true)
  await page.goto('/')

  await expect(page.getByRole('heading', { name: 'Save your recovery token' })).toBeVisible()
  await expect(page.getByTestId('recovery-token')).toHaveText(TOKEN)
  await expect(page.getByLabel('Bearer token')).toHaveCount(0)
})
