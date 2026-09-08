import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const TOKEN = 'a'.repeat(32);
const NEW_TOKEN = 'b'.repeat(32);

test('account pages retain their cursor on reload and do not fetch the legacy aggregate', async ({ page }) => {
  let aggregateReads = 0;
  const requests = await api(page, url => {
    if (url.pathname !== '/api/trading') return;
    if (url.searchParams.get('view') === 'overview') return { body: { overview: trading.overview } };
    if (url.searchParams.get('view') !== 'accounts') { aggregateReads += 1; return; }
    const later = Boolean(url.searchParams.get('cursor'));
    return { body: { accounts: [{ id: later ? 'account-old' : 'account-new', name: later ? 'Älteres Paperkonto' : 'Neues Paperkonto', exchange: 'paper', mode: 'paper', enabled: false, status: 'disabled', maxConcurrentPositions: 20, credentials: { configured: true } }], accountIncidents: [], page: { hasMore: !later, nextCursor: 'accounts-page-2' } } };
  });
  await page.goto('/trading/accounts'); await page.getByRole('button', { name: 'Weitere Konten', exact: true }).click(); await page.reload();
  await expect(page).toHaveURL(/accountsCursor=accounts-page-2/);
  await expect(page.getByRole('link', { name: 'Älteres Paperkonto', exact: true })).toHaveAttribute('href', '/trading/accounts/account-old');
  await expect(page.getByRole('button', { name: 'Weitere Konten', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Erste Kontoseite', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Neues Paperkonto', exact: true })).toBeVisible();
  expect(aggregateReads).toBe(0); expect(requests.every(request => request.method === 'GET')).toBe(true);
});

test('large setup reviews navigate complete sections and stop reading when the bound source changes', async ({ page }) => {
  let changed = false;
  const requests = await api(page, url => {
    if (url.pathname === '/api/setup-bundle/preview') return { body: { previewKey: 'large-review', expiresAt: Date.now() + 60000, bundleHash: 'reviewed-bundle', confirmation: 'REPLACE EXISTING SETUP',
      contentReview: { paged: true, effect: 'Bestehende Originale vor Ersetzen prüfen.' }, diff: { current: { nodes: 100 }, imported: { nodes: 1, edges: 0, resources: 1 } }, accountReferences: [], accountMapping: { automatic: {} } } };
    if (url.pathname === '/api/setup-bundle/review') {
      if (changed) return { status: 409, body: { error: 'SETUP_PREVIEW_CONFLICT: Original source changed.' } };
      const nested = url.searchParams.get('path') !== '[]';
      return { body: { type: nested ? 'string' : 'object', text: nested ? 'Vollständiger Originalabschnitt 🎯' : undefined,
        entries: nested ? [] : [{ key: url.searchParams.get('cursor') ? 'letzte-quelle' : 'erste-quelle', type: 'object', value: null, childCount: 35, expandable: true, path: ['quelle'] }], hasMore: !nested && !url.searchParams.get('cursor'), nextCursor: 'review-page-2' } };
    }
  });
  await page.goto('/operations/settings');
  await expect(page.getByLabel('Bundle auswählen')).toBeEnabled();
  await page.getByLabel('Bundle auswählen').setInputFiles({ name: 'setup.json', mimeType: 'application/json', buffer: Buffer.from('{}') });
  const review = page.getByRole('region', { name: 'Vollständiger Setup-Prüfbestand' });
  await review.getByRole('button', { name: 'Weitere Prüfwerte' }).click(); await review.getByRole('button', { name: 'letzte-quelle vollständig öffnen' }).click();
  await expect(review).toContainText('Vollständiger Originalabschnitt 🎯');
  changed = true; await review.getByRole('button', { name: 'Eine Ebene zurück' }).click();
  await expect(review.getByRole('alert')).toContainText('SETUP_PREVIEW_CONFLICT');
  expect(requests.filter(request => request.method === 'POST')).toHaveLength(1);
  expect(requests.some(request => request.path === '/api/setup-bundle/apply')).toBe(false);
});

test('MCP lists page independently while the selected agent and completed proposal remain addressable', async ({ page }) => {
  const agent = { id: 'metadata-agent', name: 'Beobachtungsagent', enabled: true, updatedAt: 1000, tokenPrefix: 'tsx', permissions: ['system.read'], eventSubscriptions: [] };
  const requests = await api(page, url => {
    if (url.pathname !== '/api/mcp') return;
    const later = url.searchParams.has('agentsCursor');
    return { body: { runtime: { mode: 'standby' }, agents: later ? [] : [agent], selectedAgent: url.searchParams.get('agentId') === agent.id ? agent : null,
      permissions: ['system.read'], eventTypes: [], activeSessionCount: 40, sessions: [], actions: [],
      proposals: url.searchParams.get('proposalsStatus') === 'all' ? [{ id: 'completed-original', action: 'workflow.resource_update', agentName: agent.name, status: 'completed', expiresAt: 1000 }] : [],
      pages: { agents: { hasMore: !later, nextCursor: 'agents-page-2' }, sessions: { hasMore: true, nextCursor: 'sessions-page-2' } } } };
  });
  await page.goto('/integrations/mcp'); await page.getByRole('button', { name: /Beobachtungsagent/ }).click();
  await expect(page.getByRole('heading', { name: 'Agent bearbeiten' })).toBeVisible();
  await page.getByRole('button', { name: 'Weitere Agenten', exact: true }).click(); await page.reload();
  await expect(page.getByRole('heading', { name: 'Agent bearbeiten' })).toBeVisible();
  await expect(page).toHaveURL(/agentId=metadata-agent/); await expect(page).toHaveURL(/agentsCursor=agents-page-2/);
  await page.getByRole('combobox', { name: 'Vorschlagsstatus', exact: true }).selectOption('all');
  await expect(page.getByRole('link', { name: 'Prüfen & entscheiden' })).toHaveAttribute('href', '/integrations/mcp/proposals/completed-original');
  await expect(page.getByRole('button', { name: 'Ablehnen', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Weitere Sitzungen', exact: true }).click();
  await expect(page).toHaveURL(/sessionsCursor=sessions-page-2/); await expect(page).toHaveURL(/agentsCursor=agents-page-2/);
  expect(requests.every(request => request.method === 'GET')).toBe(true);
});

test('prioritized cockpit blockers retain paging and risk acknowledgment confirms only the selected event', async ({ page }) => {
  const requests = await api(page, (url, method, body) => {
    if (url.pathname === '/api/ui/attention') return { body: { total: 21, observedAt: 2000, hasMore: !url.searchParams.get('cursor'), nextCursor: 'attention-page-2', entries: [{ kind: 'risk', id: 'risk-original', accountId: 'paper-1', reason: 'Originales Risikoereignis', createdAt: 1000, updatedAt: 1500, nextRead: { href: '/trading/risk-events?objectId=risk-original', label: 'Risikoereignis prüfen' } }] } };
    if (url.pathname === '/api/trading/objects') return { body: { entries: [{ id: 'risk-original', accountId: null, code: 'ORIGINAL_RISK', status: 'unacknowledged', severity: 'warning', acknowledgedAt: null }], states: ['unacknowledged', 'acknowledged'], hasMore: false, observedAt: 2000 } };
    if (url.pathname === '/api/trading/risk/acknowledge') { expect(method).toBe('POST'); expect(body).toEqual({ id: 'risk-original' }); return { body: { success: true } }; }
  });
  await page.goto('/cockpit'); await page.getByRole('button', { name: 'Weitere Blocker' }).click(); await page.reload();
  await expect(page).toHaveURL(/attentionCursor=attention-page-2/); await page.getByRole('link', { name: 'Risikoereignis prüfen', exact: true }).click();
  await expect(page.getByLabel('Objekt-ID', { exact: true })).toHaveValue('risk-original');
  await page.getByRole('button', { name: 'Quittierung prüfen' }).click(); await page.getByRole('button', { name: 'Abbrechen', exact: true }).click();
  expect(requests.filter(request => request.method === 'POST')).toHaveLength(0);
  await page.getByRole('button', { name: 'Quittierung prüfen' }).click(); await page.getByRole('button', { name: 'Als gesehen quittieren' }).click();
  await expect(page.getByRole('status')).toContainText('Ursache separat prüfen'); await expect(page.getByRole('button', { name: 'Quittierung prüfen' })).toBeDisabled();
  expect(requests.filter(request => request.method === 'POST')).toHaveLength(1);
});

test('deployment evidence distinguishes browser build, listener and unknown host limits for Viewer', async ({ page }) => {
  const requests = await api(page, url => {
    if (url.pathname === '/api/recovery') return { body: { active: false, session: { role: 'viewer' }, serverInstanceId: 'deployment-instance' } };
    if (url.pathname === '/api/ui/deployment') return { body: { observedAt: 1000, listener: { address: '127.0.0.1', port: 8080, interpretation: 'Interner Listener; Hostport kann abweichen.' },
      process: { nodeVersion: 'v22.23.2', platform: 'linux', availableCpuParallelism: 2, operatingSystemMemoryBytes: '4294967296', interpretation: 'Betriebssystembeobachtung.' },
      limits: { memory: null, cpu: null, interpretation: 'Nicht lesbare Limits sind unbekannt.' }, declarations: [{ name: 'HOST_WEB_PORT', value: null, source: 'process.env.HOST_WEB_PORT' }],
      boundary: 'Offline-Wartung benötigt einen unabhängigen Dienst.' } };
  });
  await page.goto('/operations/deployment'); await page.reload();
  await expect(page.getByRole('heading', { name: 'Deployment und Browserbuild' })).toBeVisible();
  await expect(page.getByText('Interner Listener; Hostport kann abweichen.', { exact: true })).toBeVisible();
  await expect(page.getByText('Nicht lesbare Limits sind unbekannt.', { exact: true })).toBeVisible();
  await expect(page.getByText('process.env.HOST_WEB_PORT', { exact: true })).toBeVisible();
  expect(requests.every(request => request.method === 'GET')).toBe(true);
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
});

test('stored originals retain text paging, explicit deletion and reference failures without replay', async ({ page }) => {
  let deleted = false;
  const requests = await api(page, (url, method) => {
    if (url.pathname === '/api/processed-signals' && method === 'DELETE') return { status: 409, body: { error: 'Trading history still references this signal.' } };
    if (url.pathname === '/api/incoming-messages' && method === 'DELETE') { expect(url.searchParams.get('id')).toBe('42'); deleted = true; return { body: { success: true } }; }
    if (url.pathname === '/api/signals/original') return deleted ? { status: 404, body: { error: 'Original absent' } } : { body: {
      id: url.searchParams.get('id'), channelId: 'source-channel', messageId: 123, createdAt: 1000, model: 'original-model',
      totalCharacters: 10012, offset: url.searchParams.has('cursor') && url.searchParams.get('cursor') ? 10000 : 0,
      text: url.searchParams.get('cursor') ? 'zweiter Originalabschnitt' : '<signal>Original</signal>', hasMore: !url.searchParams.get('cursor'), nextCursor: 'original-page-2',
    } };
  });
  await page.goto('/signals/processed/referenced-signal');
  await page.getByRole('button', { name: 'Weiterer Textabschnitt' }).click(); await page.reload();
  await expect(page.getByLabel('Originaltext')).toHaveText('zweiter Originalabschnitt');
  await page.getByRole('button', { name: 'Gespeichertes Original löschen', exact: true }).click(); await page.getByRole('button', { name: 'Abbrechen', exact: true }).click();
  expect(requests.filter(request => request.method === 'DELETE')).toHaveLength(0);
  await page.getByRole('button', { name: 'Gespeichertes Original löschen', exact: true }).click();
  await page.getByRole('dialog').getByRole('textbox').fill('referenced-signal'); await page.getByRole('button', { name: 'Dieses Original löschen' }).click();
  await expect(page.getByRole('status')).toContainText('Trading history still references');
  await expect(page.getByLabel('Originaltext')).toHaveText('zweiter Originalabschnitt');
  await page.goto('/signals/cache/42'); await page.getByRole('button', { name: 'Gespeichertes Original löschen', exact: true }).click();
  await page.getByRole('dialog').getByRole('textbox').fill('42'); await page.getByRole('button', { name: 'Dieses Original löschen' }).click();
  await expect(page.getByRole('status')).toContainText('Löschung von 42 bestätigt.'); await expect(page.getByLabel('Originaltext')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Gespeichertes Original löschen', exact: true })).toBeDisabled();
  expect(requests.filter(request => request.method === 'DELETE')).toHaveLength(2);
});

test('Viewer can read stored originals and cannot delete them', async ({ page }) => {
  const requests = await api(page, url => {
    if (url.pathname === '/api/recovery') return { body: { active: false, session: { role: 'viewer' }, serverInstanceId: 'viewer-instance' } };
    if (url.pathname === '/api/signals/original') return { body: { id: '42', channelId: 'channel', messageId: 5, createdAt: 1000, text: 'Originalquelle', offset: 0, totalCharacters: 14, hasMore: false } };
    if (url.pathname === '/api/signals/ingress') return { body: { entries: [], states: [], hasMore: false, observedAt: 1000 } };
  });
  await page.goto('/signals/cache/42'); await expect(page.getByLabel('Originaltext')).toHaveText('Originalquelle');
  await expect(page.getByRole('button', { name: 'Gespeichertes Original löschen', exact: true })).toBeDisabled();
  await page.getByRole('link', { name: 'Eingangsspur dieser Originalnachricht öffnen' }).click(); await page.reload();
  await expect(page.getByLabel('Original-Nachrichten-ID', { exact: true })).toHaveValue('5');
  await expect(page.getByLabel('Kanal', { exact: true })).toHaveValue('channel');
  expect(requests.every(request => request.method === 'GET')).toBe(true);
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
});

test('capability directory preserves Viewer restrictions, paging and parameter boundaries after reload', async ({ page }) => {
  const requests = await api(page, url => {
    if (url.pathname === '/api/recovery') return { body: { active: false, session: { role: 'viewer' }, serverInstanceId: 'directory-instance' } };
    if (url.pathname === '/api/ui/capabilities') {
      const second = url.searchParams.has('cursor');
      return { body: { contractVersion: 1, total: 2, hasMore: !second, nextCursor: 'directory-page-2', entries: [{
        route: second ? 'POST /api/trading/runtime' : 'GET /api/trading/objects', label: second ? 'Globale Handelsfreigabe' : 'Trade-Belege',
        role: second ? 'admin' : 'viewer', scope: 'Ausdrücklich gewählter Scope', href: '/trading/positions', currentBlockers: second ? ['Administratorrolle erforderlich.'] : [],
        effect: 'Eigene serverseitige Prüfung', inputVariants: 'execution|live|kill-switch', handler: 'fixture', contractTests: ['contract-fixture'],
      }] } };
    }
    if (url.pathname === '/api/ui/parameters') return { body: { contractVersion: 1, total: 1, hasMore: false, entries: [{
      path: 'resource.adaptive_risk.lockedTier', type: 'integer|null', constraints: '0..N-1 oder null', defaultPresent: false, nullable: true,
      emptyMeaning: 'null hebt das Festhalten auf; 0 hält ausdrücklich Stufe 1 fest.', source: 'Gepinnte Ressourcenfassung', scope: 'Pfad', effect: 'Nach Graphaktivierung',
      editable: true, secret: false, requiresRestart: false, href: '/workflows/builder', validator: 'contract-fixture', consumer: 'consumer-fixture',
    }] } };
  });
  await page.goto('/operations/capabilities');
  await page.getByRole('button', { name: 'Weitere Einträge' }).click(); await page.reload();
  await expect(page.getByRole('heading', { name: 'Globale Handelsfreigabe' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Administratorrolle erforderlich.');
  await page.getByRole('combobox', { name: 'Verzeichnis', exact: true }).selectOption('parameters');
  await page.getByRole('combobox', { name: 'Parameterfamilie', exact: true }).selectOption('resource'); await page.reload();
  await expect(page.getByRole('heading', { name: 'resource.adaptive_risk.lockedTier' })).toBeVisible();
  await expect(page.getByText('null hebt das Festhalten auf; 0 hält ausdrücklich Stufe 1 fest.', { exact: true })).toBeVisible();
  expect(requests.every(request => request.method === 'GET')).toBe(true);
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
});

test('analytics range and dimensions survive reload and browser back navigation', async ({ page }) => {
  const requests = await api(page, url => {
    if (url.pathname === '/api/trading/analytics') return { body: { performance: { channels: [], exchanges: [], equity: [] }, execution: {}, fallback: {} } };
  });
  await page.goto('/risk/analytics?range=7d&mode=testnet&status=completed');
  await expect(page.getByRole('combobox', { name: 'Zeitraum', exact: true })).toHaveValue('7d');
  await expect(page.getByRole('combobox', { name: 'Modus', exact: true })).toHaveValue('testnet');
  await page.getByRole('combobox', { name: 'Zeitraum', exact: true }).selectOption('90d');
  await page.reload(); await expect(page.getByRole('combobox', { name: 'Zeitraum', exact: true })).toHaveValue('90d');
  await page.getByRole('combobox', { name: 'Modus', exact: true }).selectOption('live');
  await page.goBack(); await expect(page.getByRole('combobox', { name: 'Modus', exact: true })).toHaveValue('testnet');
  await expect.poll(() => requests.filter(request => request.path === '/api/trading/analytics').length).toBeGreaterThan(0);
  expect(requests.every(request => request.method === 'GET')).toBe(true);
});

test('ingress relation paging includes album siblings and retains original links after reload', async ({ page }) => {
  const requests = await api(page, url => {
    if (url.pathname === '/api/signals/ingress/detail') return { body: { work: { id: 'ingress-1', channelId: 'channel', messageId: 5, workflowRevisionId: 'original-revision', status: 'routed' }, source: { excerpt: 'redigierte Quelle' } } };
    if (url.pathname !== '/api/signals/ingress/relations') return;
    const kind = url.searchParams.get('kind'); const second = url.searchParams.has('cursor');
    const row = kind === 'candidates' ? { id: 'candidate-1', rank: 0, accountId: 'testnet', status: 'stopped', errorCode: 'ORDER_RESULT_UNKNOWN', reason: 'Unknown order outcome; no fallback', executionPathId: 'original-path', intentId: 'intent-1' }
      : { id: second ? 'signal-second' : 'signal-first', model: 'original-model', promptSha256: 'original-prompt', workflowRevisionId: 'original-revision' };
    return { body: { entries: [row], observedAt: Date.now(), hasMore: !second && kind === 'signals', nextCursor: 'signal-page-2', interpretation: 'Originalbeziehungen einschließlich Albummitglieder.' } };
  });
  await page.goto('/signals/messages/ingress-1'); await page.getByRole('button', { name: 'Weitere Beziehungen' }).click(); await page.reload();
  await expect(page.getByText('signal-second', { exact: true })).toBeVisible();
  await page.getByLabel('Beziehung auswählen').selectOption('candidates');
  await expect(page).not.toHaveURL(/relationCursor/);
  await expect(page.getByText('ORDER_RESULT_UNKNOWN', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'original-path' })).toHaveAttribute('href', '/workflows/paths/original-path');
  expect(requests.every(request => request.method === 'GET')).toBe(true);
});

test('log regex timeout keeps navigation responsive and exposes connection and cursor gaps', async ({ page, browserName }) => {
  let failed = false;
  const requests = await api(page, url => {
    if (url.pathname === '/api/logs') return failed ? { status: 503, body: { error: 'Log source unavailable' } } : { body: { entries: [{ cursor: 10, line: '[INFO] original line' }, { cursor: 11, line: 'a'.repeat(1000) + '!' }], nextCursor: 11, dropped: true, serverInstanceId: 'logs-instance' } };
  });
  await page.goto('/operations/logs');
  await expect(page.getByRole('alert')).toContainText('Cursorlücke');
  await page.getByRole('button', { name: 'Pausieren' }).click();
  await page.getByLabel('Regex', { exact: true }).check(); await page.getByPlaceholder('Logs filtern').fill('INFO');
  await expect(page.getByRole('log').getByText('[INFO] original line')).toBeVisible();
  await page.getByPlaceholder('Logs filtern').fill('(a+)+$');
  // WebKit terminates this pathological expression internally; the other engines exercise our worker timeout.
  if (browserName === 'webkit') await expect(page.getByRole('log')).toContainText('Keine passenden Log-Einträge.');
  else await expect(page.getByText(/Regex-Suche nach 500 ms abgebrochen/)).toBeVisible();
  await page.getByLabel('Regex', { exact: true }).uncheck(); await page.getByPlaceholder('Logs filtern').fill('original');
  await expect(page.getByRole('log').getByText('[INFO] original line')).toBeVisible();
  failed = true; await page.getByRole('button', { name: 'Fortsetzen' }).click();
  await expect(page.getByText(/Log source unavailable/)).toBeVisible();
  await expect(page.getByRole('log').getByText('[INFO] original line')).toBeVisible();
  await page.getByRole('link', { name: 'Cockpit', exact: true }).click(); await expect(page).toHaveURL(/cockpit$/);
  expect(requests.every(request => request.method === 'GET')).toBe(true);
});


test('adaptive evidence preserves original policy hashes, invalidation and one-based tiers across paging and reload', async ({ page }) => {
  const requests = await api(page, (url) => {
    if (url.pathname === '/api/recovery') return { body: { active: false, session: { role: 'viewer', actorId: 'viewer' }, serverInstanceId: 'instance-1' } };
    if (url.pathname !== '/api/trading/risk/adaptive') return;
    const kind = url.searchParams.get('kind') || 'states';
    const row = { id: 'original-evaluation', accountName: 'Belegkonto', mode: 'testnet', channelId: 'channel', stateKey: 'scope', resourceId: 'risk-resource',
      previousTier: 0, recommendedTier: 1, appliedTier: 0, realizedPnl: '-0.000000000000000001', realizedPnlValue: null, returnPercent: null,
      startingEquity: '10000', reportingCurrency: 'USDT', weekStartedAt: 1000, weekEndedAt: 2000, createdAt: 2000, closedTrades: 5,
      policySha256: 'original-policy-hash', matchesCurrentStatePolicy: false, invalidatedAt: 3000, invalidationReason: 'Original FX source changed' };
    if (kind === 'sources') return { body: { entries: [{ intentId: 'intent-1', closedAt: 1500, projectionHash: 'original-projection', valuationHash: 'original-valuation' }], sourceAvailable: true, hasMore: false, sourceCount: 1, sourceHash: 'original-source-hash', capital: { equity: '10000', reportingCurrency: 'USDT', basis: 'current_bound_input' }, scope: { since: 1000, until: 2000 } } };
    if (kind === 'evaluations') return { body: { entries: [{ ...row, id: url.searchParams.has('cursor') ? 'older-evaluation' : row.id }], hasMore: !url.searchParams.has('cursor'), nextCursor: 'page-2', observedAt: 3000 } };
    if (kind === 'paths') return { body: { entries: [], hasMore: false } };
    return { body: { entries: [{ ...row, currentTier: 0, lockedTier: null, blocked: true, blockReason: 'Original FX source changed', latestEvaluationId: row.id }], hasMore: false, observedAt: 3000 } };
  });
  await page.goto('/risk/adaptive?kind=states&stateKey=scope'); await page.reload();
  await expect(page.getByText('Stufe 1', { exact: true })).toBeVisible(); await expect(page.getByText('nicht festgehalten', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Letzte Auswertung dieser Policy' }).click();
  await expect(page.getByRole('heading', { name: 'Auswertung original-evaluation' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('ungültig geworden');
  await expect(page.getByText('original-policy-hash', { exact: true })).toBeVisible();
  await expect(page.getByText('Stufe 2', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Originale Datenbasis öffnen' }).click();
  await expect(page.getByRole('region', { name: 'Kapitalbasis und Auswertungszeitraum', exact: true })).toContainText('current_bound_input');
  await page.getByRole('button', { name: 'Weitere Policyeinträge' }).click(); await page.reload();
  await expect(page.getByRole('heading', { name: 'Auswertung older-evaluation' })).toBeVisible();
  expect(requests.every(request => request.method === 'GET')).toBe(true);
});

test('Legacy risk migration preserves null and blockers in a reviewed draft and never activates the graph', async ({ page }) => {
  let copied = false;
  const requests = await api(page, (url, method, body) => {
    if (url.pathname === '/api/trading/risk/adaptive/copy-legacy') {
      expect(method).toBe('POST'); expect(body).toEqual({ channelId: 'legacy-channel', copyHash: 'reviewed-copy-hash' }); copied = true;
      return { body: { resource: { id: 'copy-1', resourceId: 'legacy-copy', name: 'Legacy policy', status: 'draft' }, alreadyCopied: false, activated: false } };
    }
    if (url.pathname === '/api/trading/risk/adaptive') return { body: { observedAt: Date.now(), hasMore: false, entries: [{
      policy: { channelId: 'legacy-channel', currentTier: 0, lockedTier: null, mode: 'automatic', blocked: true, blockReason: 'Legacy loss limit', policyVersion: 3 },
      configuration: { enabled: true, mode: 'automatic', startingTier: 0, lockedTier: null, manuallyBlocked: true, tiers: [{ riskPercent: '0.125' }] }, copyHash: 'reviewed-copy-hash'
    }] } };
  });
  await page.goto('/risk/adaptive?kind=legacy');
  await expect(page.getByRole('region', { name: 'Geprüfte Werte des neuen Workflowentwurfs', exact: true })).toContainText('0.125');
  await page.getByRole('button', { name: 'Als Workflowentwurf übernehmen' }).click(); await page.keyboard.press('Escape'); expect(copied).toBe(false);
  await page.getByRole('button', { name: 'Als Workflowentwurf übernehmen' }).click();
  await page.getByRole('button', { name: 'Geprüften Entwurf anlegen' }).click();
  await expect(page.getByRole('status')).toContainText('nicht aktiviert'); await expect(page.getByRole('link', { name: 'Ressourcenentwurf öffnen' })).toHaveAttribute('href', '/workflows/resources/legacy-copy/versions/copy-1');
  expect(requests.filter(request => request.method === 'POST')).toHaveLength(1);
});

const aiLimits = { maxInputChars: 10000, maxOutputTokens: 1024, primaryAttempts: 1, fallbackAttempts: 0, dailyRequestLimit: 100, dailyTokenLimit: 10000, requestTimeoutMs: 250000, backoffMs: 0 };
const trading = { overview: { runtime: { executionEnabled: false, liveTradingEnabled: false, killSwitchActive: true } }, accounts: [], strategies: [], signalSchemas: [], signalContracts: [], intents: [], activity: { positions: [], orders: [], fills: [], riskEvents: [], reconciliations: [], paperMarkets: [] }, workflowAdaptiveRisk: { states: [], evaluations: [] }, exchangeStreams: [], accountIncidents: [], fallbackRuns: [] };
const entry = { intentId: 'intent-1', symbol: 'BTCUSDT', side: 'LONG', status: 'monitoring', accountId: 'paper-1', accountName: 'Paper 1', exchange: 'paper', mode: 'paper', channelId: 'channel-1', createdAt: 1000, workflowRevisionId: 'original-revision', executionPathId: 'path-1', signalRunId: 'run-1', signal: { id: 'signal-1', sourceMessageId: 42 }, strategy: { name: 'Original', id: 'strategy-v3', version: 3, configurationSha256: 'original-hash' }, plan: { entryPrice: '60000.00000001', quantity: '0.001', leverage: 10 }, position: null, orders: [], fills: [], timeline: {}, review: { notes: '', tags: [], rating: null, reviewed: false, updatedAt: null } };

test('standalone model recovery binds the accepted model and keeps the receipt when refresh fails', async ({ page }) => {
  let attached = false;
  const requests = await api(page, (url, method, body) => {
    if (url.pathname !== '/api/workflow/models') return;
    if (method === 'POST') {
      expect(body).toEqual({ id: 'orphan-model', kind: 'strategy', action: 'attach', reviewHash: 'original-model-review' }); attached = true;
      return { body: { kind: 'strategy', id: 'orphan-model', action: 'attach', resource: { id: 'wrapper-v1', resourceId: 'wrapper', name: 'Recovered', status: 'draft' } } };
    }
    if (attached) return { status: 503, body: { error: 'Read source temporarily unavailable' } };
    if (!url.searchParams.has('id')) return { body: { entries: [{ id: 'orphan-model', name: 'Recovered model', status: 'draft', createdAt: 1000 }], hasMore: false, observedAt: Date.now() } };
    return { body: { kind: 'strategy', model: { id: 'orphan-model', name: 'Recovered model', status: 'draft', configuration: { riskPercent: '0.000000000000000012345', enabled: false } }, reviewHash: 'original-model-review', resources: [], resourceCount: 0, activeReferenceCount: 0, observedAt: Date.now(), effect: 'No graph activation' } };
  });
  await page.goto('/workflows/models/strategy'); await page.getByRole('link', { name: 'Recovered model' }).click();
  await page.reload(); await expect(page.getByRole('region', { name: 'Gespeicherte Modelldefinition', exact: true })).toContainText('0.000000000000000012345');
  await page.getByRole('button', { name: 'Als Ressourcenentwurf übernehmen' }).click();
  await expect(page.getByRole('dialog')).toContainText('Keine Graphaktivierung');
  await page.getByRole('button', { name: 'Geprüfte Aktion ausführen' }).click();
  await expect(page.getByRole('status')).toContainText('Modellaktion attach bestätigt');
  await expect(page.getByRole('link', { name: 'Gespeicherten Ressourcenentwurf öffnen' })).toHaveAttribute('href', '/workflows/resources/wrapper/versions/wrapper-v1');
  await expect(page.getByRole('alert')).toContainText('Aktion bestätigt; Objektstand');
  expect(requests.filter(request => request.method === 'POST')).toHaveLength(1);
});

test('mobile risk evidence separates live and testnet, stale observations and an unavailable money source', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ reducedMotion: 'reduce' });
  const requests = await api(page, url => {
    if (url.pathname === '/api/recovery') return { body: { active: false, session: { role: 'viewer', actorId: 'viewer' }, serverInstanceId: 'instance-1' } };
    if (url.pathname !== '/api/trading/accounts/evidence') return;
    const accountId = url.searchParams.get('accountId'); const kind = url.searchParams.get('kind');
    if (kind === 'history') return { body: { entries: [], hasMore: false, observedAt: Date.now(), interpretation: 'Gespeicherte Historie, keine Providerabfrage' } };
    if (kind === 'reservations') return { body: { entries: [{ intentId: 'intent-1', sourceHash: 'original-source', markPrice: '60000.00000001', stopPrice: '59000', protectionProven: null, amounts: { status: 'unresolved', reason: 'FX originals unresolved', reportingCurrency: 'USDT', additionalRisk: null } }], hasMore: false, observation: { id: 'old-observation', timestampFresh: false, isCurrentObservation: true, observedAt: 1000 }, interpretation: 'Originale gespeicherte Risikoreservierungen' } };
    return { body: { account: { id: accountId, name: `Konto ${accountId}`, exchange: 'bybit', mode: accountId }, observedAt: Date.now(), daily: null,
      risk: { id: 'old-observation', observedAt: 1000, expiresAt: 2000, timestampFresh: false, identityMatches: false, credentialGenerationMatches: false, reservationCount: 1, equity: null, availableBalance: null },
      errors: [{ source: 'daily-money', reason: 'Monetary projection temporarily unavailable' }], baseline: null, requiredHistorySince: 1000 } };
  });
  for (const mode of ['testnet', 'live']) {
    await page.goto(`/risk/accounts/${mode}`); await page.reload();
    await expect(page.getByRole('heading', { name: `Konto ${mode} · Risiko & Historie` })).toBeVisible();
    await expect(page.getByText(`bybit/${mode}`, { exact: false }).first()).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('Monetary projection temporarily unavailable');
    await expect(page.getByRole('heading', { name: 'Provider-Historienfortschritt' })).toBeVisible();
    await page.getByText('Stoprisiko, Quelle und FX', { exact: true }).click();
    await expect(page.getByRole('region', { name: 'Risikobeträge aus der Originalbeobachtung', exact: true })).toContainText('FX originals unresolved');
    await expect(page.getByText('60000.00000001', { exact: true })).toBeVisible();
    await expect(page.getByText(/Zeitgrenze abgelaufen oder ungültig/)).toBeVisible();
  }
  expect(requests.every(request => request.method === 'GET')).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('ui-next-risk-mobile.png'), fullPage: true });
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
});

test('dirty navigation uses a keyboard dialog and cancellation retains the draft', async ({ page }) => {
  const requests = await api(page);
  await page.goto('/trading/trades/intent-1'); await page.getByLabel('Notizen').fill('Ungespeicherte Reviewnotiz');
  await page.getByRole('link', { name: 'Cockpit', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Ungespeicherte Änderungen verwerfen?' });
  await expect(dialog).toBeVisible(); await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0); await expect(page).toHaveURL(/trading\/trades\/intent-1$/);
  await expect(page.getByLabel('Notizen')).toHaveValue('Ungespeicherte Reviewnotiz');
  await page.getByRole('link', { name: 'Cockpit', exact: true }).click();
  await page.getByRole('button', { name: 'Verwerfen und verlassen' }).click();
  await expect(page).toHaveURL(/\/cockpit$/); expect(requests.every(request => request.method === 'GET')).toBe(true);
});

test('MCP detail requires reviewed content and invalidates consent when the object changes', async ({ page }) => {
  let version = 1; let status = 'pending';
  const proposal = () => ({ id: 'proposal-1', action: 'risk.update', status, agentName: 'Review agent', requestedAt: Date.now() - 60000, expiresAt: Date.now() + 1000000,
    payload: { channelId: 'channel-1', riskPercent: '2.125', nullable: null, enabled: false }, preflight: { checkedAt: Date.now() - 60000 }, result: status === 'completed' ? { riskPercent: '2.125' } : null });
  const requests = await api(page, (url, method, body) => {
    if (url.pathname === '/api/mcp/proposals/detail') return { body: { contractVersion: 1, reviewHash: `hash-${version}`, observedAt: Date.now(), proposal: proposal(), before: { riskPercent: String(version) }, requested: { riskPercent: '2.125' },
      interpretation: 'Beantragte Änderung künftiger Trades', freshPreflight: { allowed: true, checkedAt: Date.now(), blockers: [], impact: ['Risk policy changes'] }, scope: { accountIds: ['paper-1'], paths: [], activeRevisionId: 'revision-1' } } };
    if (url.pathname === '/api/mcp/proposals/approve' && method === 'POST') { expect(body.reviewHash).toBe('hash-2'); status = 'approved'; return { body: { proposal: proposal() } }; }
  });
  await page.goto('/integrations/mcp/proposals/proposal-1');
  await expect(page.getByRole('heading', { name: /Vorschlag prüfen/ })).toBeVisible();
  const approve = page.getByRole('button', { name: 'Geprüften Vorschlag freigeben' }); const consent = page.getByRole('checkbox', { name: /Inhalt, Scope/ });
  await expect(approve).toBeDisabled(); await consent.check(); await expect(approve).toBeEnabled();
  version = 2; await expect(consent).not.toBeChecked({ timeout: 10000 }); await expect(approve).toBeDisabled();
  await page.getByText('Vollständiger redigierter Antragsinhalt', { exact: true }).click();
  await expect(page.getByRole('region', { name: 'Antragsinhalt', exact: true })).toContainText('null · kein Wert');
  await consent.check(); await approve.click(); await expect(page.getByRole('status').filter({ hasText: 'Freigabe bestätigt' })).toBeVisible();
  status = 'completed'; await expect(page.getByRole('heading', { name: 'Bestätigtes Ausführungsergebnis' })).toBeVisible({ timeout: 10000 });
  await page.reload(); await expect(page.getByRole('heading', { name: 'Bestätigtes Ausführungsergebnis' })).toBeVisible();
  expect(requests.filter(request => request.method === 'POST')).toHaveLength(1);
});

test('setup content comparison preserves exact values and a stale preview never retries replacement', async ({ page }) => {
  const requests = await api(page, (url, method) => {
    if (url.pathname === '/api/setup-bundle/preview') return { body: { previewKey: 'setup-1', bundleHash: 'fixture', expiresAt: Date.now() + 60000, confirmation: 'REPLACE EXISTING SETUP',
      diff: { current: { nodes: 0 }, imported: { nodes: 1, edges: 0, resources: 1 } }, accountReferences: [], accountMapping: { automatic: {} },
      contentReview: { before: { risk: '0.000000000000000001', enabled: true }, after: { risk: '0.000000000000000002', enabled: false }, existingLibrary: { resources: [] }, effect: 'Ungebundene Entwürfe werden ebenfalls geprüft.' } } };
    if (url.pathname === '/api/setup-bundle/apply' && method === 'POST') return { status: 409, body: { error: 'SETUP_PREVIEW_CONFLICT: Neue Vorschau erforderlich.' } };
  });
  await page.goto('/operations/settings');
  await expect(page.getByLabel('Bundle auswählen')).toBeEnabled();
  await page.getByLabel('Bundle auswählen').setInputFiles({ name: 'fixture.json', mimeType: 'application/json', buffer: Buffer.from('{}') });
  const review = page.getByRole('region', { name: 'Setup-Inhalte vor und nach dem Import', exact: true });
  await expect(review).toContainText('0.000000000000000001'); await expect(review).toContainText('0.000000000000000002');
  await page.getByLabel('Zum Ersetzen exakt „REPLACE EXISTING SETUP“ eingeben').fill('REPLACE EXISTING SETUP');
  await page.getByRole('button', { name: 'Bestehendes Setup sicher ersetzen' }).click();
  await expect(page.getByText(/SETUP_PREVIEW_CONFLICT: Neue Vorschau erforderlich\./)).toBeVisible();
  expect(requests.filter(request => request.path === '/api/setup-bundle/apply')).toHaveLength(1);
});

test('resource version address reloads, edits a draft, and publishes only after explicit review', async ({ page }) => {
  let resource = { id: 'resource-v1', resourceId: 'family-1', version: 1, kind: 'channel', name: 'Original channel', description: '', status: 'draft', editRevision: 0, configuration: { channelId: '-1001234567' }, configurationSha256: 'hash', createdAt: 1000, publishedAt: null as number | null };
  const requests = await api(page, (url, method, body) => {
    if (url.pathname === '/api/workflow/objects') return { body: url.searchParams.has('id') ? { resource, publication: { publicationHash: `publication-${resource.editRevision}`, dependency: null }, activePaths: [], effect: 'Gespeicherte Quelle, noch kein aktiver Signalweg.', observedAt: Date.now() } : { entries: [resource], hasMore: false, observedAt: Date.now() } };
    if (url.pathname === '/api/workflow/resources/update' && method === 'POST') { expect(body.baseEditRevision).toBe(0); resource = { ...resource, ...body, editRevision: 1 }; return { body: { resource } }; }
    if (url.pathname === '/api/workflow/resources/publish' && method === 'POST') { expect(body.publishDependencies).toBe(true); expect(body.publicationHash).toBe('publication-1'); resource = { ...resource, status: 'published', publishedAt: Date.now() }; return { body: { resource } }; }
  });
  await page.goto('/workflows/resources'); await page.getByRole('link', { name: 'Original channel · v1' }).click(); await page.reload();
  await expect(page.getByRole('heading', { name: 'Original channel · Version 1' })).toBeVisible();
  await page.getByRole('button', { name: 'Entwurf bearbeiten' }).click();
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('Edited channel');
  await page.getByRole('dialog').getByRole('button', { name: 'Ressourcen- und Graphentwurf speichern' }).click();
  await expect(page.getByRole('heading', { name: 'Edited channel · Version 1' })).toBeVisible();
  expect(requests.filter(request => request.path.includes('/publish'))).toHaveLength(0);
  await page.getByRole('button', { name: 'Version publizieren', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Publizieren', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Publikation bestätigt' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Neue Version als Entwurf' })).toBeVisible();
  expect(requests.some(request => request.path === '/api/workflow/mutate')).toBe(false);
  expect(requests.filter(request => request.path.endsWith('/publish'))).toHaveLength(1);
});

test('global search keeps its text outside URLs and lets a viewer open the original trade', async ({ page }) => {
  const searchRequests: Array<{ url: string; query?: string }> = [];
  page.on('request', request => { if (request.url().includes('/api/ui/search')) searchRequests.push({ url: request.url(), query: request.headers()['x-ui-search'] }); });
  const requests = await api(page, url => {
    if (url.pathname === '/api/recovery') return { body: { active: false, session: { role: 'viewer', actorId: 'viewer' }, serverInstanceId: 'instance-1' } };
    if (url.pathname === '/api/ui/search') return { body: { groups: [{ kind: 'intents', observedAt: Date.now(), entries: [{ id: 'intent-1', title: 'BTCUSDT · LONG', subtitle: 'paper · monitoring', url: '/trading/trades/intent-1' }], hasMore: false }] } };
  });
  await page.goto('/trading/journal'); await page.getByRole('button', { name: 'Global suchen' }).click();
  const dialog = page.getByRole('dialog', { name: 'Globale Suche' }); await dialog.getByLabel('Suchbegriff').fill('BTCUSDT');
  await dialog.getByRole('link', { name: 'BTCUSDT · LONG' }).click(); await expect(page).toHaveURL(/\/trading\/trades\/intent-1$/);
  await expect(page.getByRole('button', { name: 'Review speichern' })).toBeDisabled();
  expect(searchRequests.length).toBeGreaterThan(0); expect(searchRequests.every(request => !request.url.includes('BTCUSDT') && request.query === 'BTCUSDT')).toBe(true);
  expect(requests.some(request => request.method !== 'GET')).toBe(false);
  await page.getByRole('button', { name: 'Global suchen' }).click(); await expect(page.getByRole('dialog').getByLabel('Suchbegriff')).toHaveValue('');
});
type Reply = { status?: number; body: unknown };
async function api(page: Page, override?: (url: URL, method: string, body: any) => Reply | undefined | Promise<Reply | undefined>) {
  const requests: Array<{ path: string; query: string; method: string; body: any; authorization?: string }> = [];
  await page.addInitScript((token) => sessionStorage.setItem('forwarder-dashboard-token', token), TOKEN);
  await page.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const body = request.postData() ? JSON.parse(request.postData()!) : null;
    requests.push({ path: url.pathname, query: url.search, method, body, authorization: request.headers().authorization });
    const custom = await override?.(url, method, body);
    const common: Record<string, unknown> = {
      '/api/bootstrap/status': { required: false, localSessionAvailable: false },
      '/api/recovery': { active: false, backendVersion: '3.3.0', serverInstanceId: 'instance-1', observedAt: Date.now(), session: { role: 'admin', actorId: 'test:admin' }, availableRepairs: ['config', 'runtime-settings', 'secrets', 'restart'] },
      '/api/trading': trading,
      '/api/status': { connectionState: 'disconnected', isRunning: false, queue: { running: 0, queued: 0 }, telegramLogin: { state: 'idle' } },
      '/api/exchanges/catalog': { implementation: {}, exchanges: [] },
      '/api/access': { role: 'admin', actorId: 'test:admin' },
      '/api/operations': { operations: {} },
      '/api/config': { apiId: 0, targetChannel: '', xmlParsing: { model: 'model-1', fallbackModel: 'fallback-1', aiLimits, saveToFile: true, signalsDir: './original-signals' } },
      '/api/runtime-settings': { settings: { dashboardAuthMode: 'token', dashboardLocalTrust: false, dashboardAllowedOrigin: '', tailscaleAdminUsers: '', tailscaleViewerUsers: '', enterpriseMode: false } },
      '/api/secrets': { secrets: { auditWebhookToken: { configured: false, source: 'missing', editable: true } } },
      '/api/trading/journal': { entries: [], hasMore: false, observedAt: Date.now() },
      '/api/trading/intents/detail': { entry, observedAt: Date.now() },
    };
    await route.fulfill({ status: custom?.status ?? (custom || url.pathname in common ? 200 : 503), contentType: 'application/json', body: JSON.stringify(custom?.body ?? common[url.pathname] ?? { error: 'unavailable' }) });
  });
  return requests;
}

test('seven-area navigation and journal pagination do not depend on workflow or catalog loads', async ({ page }) => {
  const requests = await api(page, (url) => url.pathname === '/api/trading/journal' ? { body: { entries: [{ ...entry, intentId: url.searchParams.get('cursor') ? 'intent-2' : 'intent-1' }], hasMore: !url.searchParams.get('cursor'), nextCursor: 'next-page', observedAt: Date.now() } } : undefined);
  await page.goto('/trading/journal');
  await expect(page.getByRole('navigation', { name: 'Hauptbereiche', exact: true }).getByRole('link')).toHaveCount(7);
  await expect(page.getByRole('link', { name: 'BTCUSDT · LONG' })).toHaveAttribute('href', '/trading/trades/intent-1');
  await page.getByRole('button', { name: 'Nächste Seite' }).click();
  await expect(page.getByRole('link', { name: 'BTCUSDT · LONG' })).toHaveAttribute('href', '/trading/trades/intent-2');
  await page.reload();
  await expect(page.getByRole('link', { name: 'BTCUSDT · LONG' })).toHaveAttribute('href', '/trading/trades/intent-2');
  expect(requests.some((request) => ['/api/workflow', '/api/exchanges/catalog', '/api/status'].includes(request.path))).toBe(false);
});

test('recovery uses only its permitted minimal reads and secret repair preserves configuration', async ({ page }) => {
  const requests = await api(page, (url, method) => {
    if (url.pathname === '/api/recovery') return { body: { active: true, serverInstanceId: 'repair-1', session: { role: 'admin' }, issues: [{ component: 'configuration', reason: 'Repair needed' }], availableRepairs: ['config', 'runtime-settings', 'secrets'] } };
    if (url.pathname === '/api/secrets' && method === 'POST') return { body: { success: true } };
  });
  await page.goto('/recovery');
  await expect(page.getByRole('heading', { name: 'TSX Core · Recovery' })).toBeVisible();
  await page.getByLabel(/auditWebhookToken/).fill('c'.repeat(32));
  await page.getByRole('button', { name: 'Secrets speichern', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'secrets gespeichert' })).toBeVisible();
  expect(requests.filter((request) => request.method === 'POST')).toEqual([expect.objectContaining({ path: '/api/secrets', body: { auditWebhookToken: 'c'.repeat(32) } })]);
  expect(requests.some((request) => ['/api/status', '/api/access', '/api/operations', '/api/trading', '/api/workflow'].includes(request.path))).toBe(false);
});

test('token rotation displays the one-time response even when a follow-up read returns 401', async ({ page }) => {
  let rotated = false;
  const requests = await api(page, (url, method) => {
    if (url.pathname === '/api/access-tokens' && method === 'POST') { rotated = true; return { status: 201, body: { token: NEW_TOKEN, role: 'admin' } }; }
    if (rotated && method === 'GET' && url.pathname !== '/api/bootstrap/status') return { status: 401, body: { error: 'follow-up authentication unavailable' } };
  });
  await page.goto('/operations/settings');
  await page.getByRole('button', { name: 'Admin-Key rotieren', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Key rotieren', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Einmaliger Zugangsschlüssel' })).toContainText(NEW_TOKEN);
  await expect(page.getByRole('heading', { name: 'Dashboard authentication' })).toBeVisible();
  expect(requests.filter((request) => request.path === '/api/access-tokens')).toHaveLength(1);
  expect(requests.filter((request) => request.path === '/api/runtime-settings').at(-1)?.authorization).toBe(`Bearer ${NEW_TOKEN}`);
});

test('MCP polling preserves the draft and exposes concurrent edits', async ({ page }) => {
  let revision = 1;
  await api(page, (url) => url.pathname === '/api/mcp' ? { body: { runtime: { mode: 'standby' }, agents: [{ id: 'agent-1', name: 'Operator', enabled: true, updatedAt: revision, tokenPrefix: 'tsx', permissions: ['system.read'], eventSubscriptions: [] }], permissions: ['system.read'], eventTypes: [], proposals: [], sessions: [], actions: [] } } : undefined);
  await page.goto('/integrations/mcp');
  await page.getByRole('button', { name: /Operator tsx/ }).click();
  await page.getByLabel('Name', { exact: true }).fill('Mein Entwurf');
  revision = 2;
  await expect(page.getByText('Der Serverstand wurde geändert. Speichern ist bis zum Vergleich gesperrt.')).toBeVisible({ timeout: 10000 });
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Mein Entwurf');
  await expect(page.getByRole('button', { name: 'Speichern', exact: true })).toBeDisabled();
});

test('trade review preserves null, false and empty values without changing its pinned plan', async ({ page }) => {
  let current = structuredClone(entry);
  const requests = await api(page, (url, method, body) => {
    if (url.pathname === '/api/trading/intents/detail') return { body: { entry: current, observedAt: Date.now() } };
    if (url.pathname === '/api/trading/journal' && method === 'POST') { current = { ...current, review: { ...body, updatedAt: Date.now() } }; return { body: { success: true } }; }
  });
  await page.goto('/trading/trades/intent-1');
  await page.getByRole('button', { name: 'Review speichern', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Review gespeichert' })).toBeVisible();
  expect(requests.filter((request) => request.method === 'POST')).toEqual([expect.objectContaining({ body: { intentId: 'intent-1', notes: '', tags: [], rating: null, reviewed: false, baseReviewUpdatedAt: null } })]);
  expect(current.plan).toEqual(entry.plan);
  await expect(page.getByText('60000.00000001', { exact: true })).toBeVisible();
});

test('viewer can read an exact trade but cannot submit its review', async ({ page }) => {
  const requests = await api(page, (url) => url.pathname === '/api/recovery' ? { body: { active: false, session: { role: 'viewer', actorId: 'viewer' }, serverInstanceId: 'instance-1' } } : undefined);
  await page.goto('/trading/trades/intent-1');
  await expect(page.getByRole('button', { name: 'Review speichern' })).toBeDisabled();
  await expect(page.getByLabel('Notizen')).toBeDisabled();
  expect(requests.some((request) => request.method !== 'GET')).toBe(false);
});

for (const status of [403, 412]) {
  test(`delayed ${status} review rejection preserves the draft and session without a repeated write`, async ({ page }) => {
    let releaseReply!: () => void;
    const pendingReply = new Promise<void>(resolve => { releaseReply = resolve; });
    let detailReads = 0;
    const rejection = status === 403 ? 'Review permission was revoked.' : 'Review precondition is no longer satisfied.';
    const requests = await api(page, async (url, method) => {
      if (url.pathname === '/api/trading/intents/detail') { detailReads += 1; return { body: { entry, observedAt: Date.now() } }; }
      if (url.pathname === '/api/trading/journal' && method === 'POST') {
        await pendingReply;
        return { status, body: { error: rejection } };
      }
    });
    await page.goto('/trading/trades/intent-1');
    const notes = page.getByLabel('Notizen'); const save = page.getByRole('button', { name: 'Review speichern', exact: true });
    await notes.fill('Retained review draft'); await save.click();
    await expect(save).toBeDisabled(); await expect(notes).toBeDisabled();
    expect(requests.filter(request => request.method === 'POST')).toHaveLength(1);
    releaseReply();
    await expect(page.getByRole('alert').filter({ hasText: rejection })).toBeVisible();
    await expect(save).toBeEnabled(); await expect(notes).toHaveValue('Retained review draft');
    const readsAfterRejection = detailReads;
    await expect.poll(() => detailReads, { timeout: 10000 }).toBeGreaterThan(readsAfterRejection);
    await expect(notes).toHaveValue('Retained review draft');
    await expect(page.getByRole('heading', { name: 'Dashboard authentication' })).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: 'Review gespeichert' })).toHaveCount(0);
    expect(await page.evaluate(() => sessionStorage.getItem('forwarder-dashboard-token'))).toBe(TOKEN);
    expect(requests.filter(request => request.method === 'POST')).toHaveLength(1);
    expect(requests.filter(request => request.path === '/api/trading/intents/detail').at(-1)?.authorization).toBe(`Bearer ${TOKEN}`);
  });
}

test('graph drafts survive reload and activate only through the explicit activation step', async ({ page }) => {
  const graph = { schemaVersion: 3, nodes: [], edges: [] };
  let draft: any = null;
  let workflow: any = null;
  const requests = await api(page, (url, method, body) => {
    if (url.pathname === '/api/workflow') return { body: { workflow, resources: [] } };
    if (url.pathname === '/api/workflow/history') return { body: { history: { undo: [], redo: [], maxDepth: 5 } } };
    if (url.pathname === '/api/workflow/drafts') {
      if (method === 'POST') draft = { ...body, graph, version: (draft?.version ?? 0) + 1, expiresAt: Date.now() + 100000 };
      return { body: { draft } };
    }
    if (url.pathname === '/api/workflow/impact') return { body: { impact: { destructive: false } } };
    if (url.pathname === '/api/workflow/mutate') {
      workflow = { id: 'revision-1', revision: 1, status: 'active', graph, compiled: { paths: [], warnings: [] } };
      return { body: { workflow } };
    }
  });
  await page.goto('/workflows/builder');
  await page.getByRole('button', { name: 'Graphentwurf speichern', exact: true }).click();
  await expect(page.getByText(/Graphentwurf 1 gespeichert/)).toBeVisible();
  expect(requests.some(request => request.path === '/api/workflow/mutate')).toBe(false);
  await page.reload();
  await expect(page.getByText(/Graphentwurf 1 · Basis/)).toBeVisible();
  await page.getByRole('button', { name: 'Tabellenansicht anzeigen' }).click();
  await expect(page.getByRole('heading', { name: 'Graph als Tabelle' })).toBeVisible();
  await page.getByRole('button', { name: 'Gespeicherten Graph aktivieren' }).click();
  await expect(page.getByText(/Revision 1 ist aktiv/)).toBeVisible();
  expect(requests.filter(request => request.path === '/api/workflow/mutate')).toHaveLength(1);
});

test('History cancellation preserves a distinct graph draft and accepted restoration saves the new base explicitly', async ({ page }) => {
  const empty = { schemaVersion: 3, nodes: [], edges: [] };
  const resource = { id: 'history-channel-v1', resourceId: 'history-channel', version: 1, kind: 'channel', name: 'Eigenständiger Entwurf', description: '', status: 'published', configuration: { channelId: '-1001234567' } };
  let workflow: any = { id: 'history-active-1', revision: 1, graph: empty, compiled: { paths: [], warnings: [] } };
  let draft: any = { id: 'operator', version: 1, baseRevisionId: workflow.id, graph: { ...empty, nodes: [{ id: 'history-node', kind: 'channel', resourceVersionId: resource.id, position: { x: 0, y: 0 } }] } };
  const history = { limit: 5, undoCount: 1, redoCount: 0, canUndo: true, canRedo: false, undoLabel: 'Historischer Stand', redoLabel: null };
  const requests = await api(page, (url, method, body) => {
    if (url.pathname === '/api/workflow') return { body: { workflow, resources: [resource] } };
    if (url.pathname === '/api/workflow/history') return { body: history };
    if (url.pathname === '/api/workflow/drafts') {
      if (method === 'POST') { expect(body.baseRevisionId).toBe('history-active-2'); expect(body.graph.nodes).toEqual([]); draft = { ...body, version: 2 }; }
      return { body: { draft } };
    }
    if (url.pathname === '/api/workflow/history/impact') return { body: { impact: { destructive: false, changed: [], removed: [] } } };
    if (url.pathname === '/api/workflow/history/apply') { workflow = { ...workflow, id: 'history-active-2', revision: 2 }; return { body: { workflow, history } }; }
  });
  await page.goto('/workflows/builder'); await expect(page.getByText(/Graphentwurf 1 · Basis history-active-1/)).toBeVisible();
  await page.getByRole('button', { name: /rückgängig/ }).click(); await page.getByRole('button', { name: 'Abbrechen', exact: true }).click();
  expect(requests.filter(request => request.method === 'POST')).toHaveLength(0);
  await expect(page.getByText(/Graphentwurf 1 · Basis history-active-1/)).toBeVisible();
  await page.getByRole('button', { name: /rückgängig/ }).click(); await page.getByRole('button', { name: 'History-Wechsel durchführen' }).click();
  await expect(page.getByText(/Basis history-active-2 · ungespeicherte Änderungen/)).toBeVisible();
  expect(requests.filter(request => request.path === '/api/workflow/drafts' && request.method === 'POST')).toHaveLength(0);
  await page.getByRole('button', { name: 'Graphentwurf speichern', exact: true }).click(); await page.reload();
  await expect(page.getByText(/Graphentwurf 2 · Basis history-active-2/)).toBeVisible();
  expect(requests.filter(request => request.path === '/api/workflow/history/apply')).toHaveLength(1);
  expect(requests.filter(request => request.path === '/api/workflow/mutate')).toHaveLength(0);
});

test('backup transport failure preserves a job lookup and never repeats the command', async ({ page }) => {
  let requestedId = '';
  const requests = await api(page, (url, method, body) => {
    if (url.pathname === '/api/backups') return { body: { backups: ['backup-2026-fixture'] } };
    if (url.pathname === '/api/operations/backup' && method === 'POST') { requestedId = body.jobId; return { status: 503, body: { error: 'Result acknowledgement unavailable' } }; }
    if (url.pathname === '/api/operations/jobs') return { body: { job: { id: requestedId, kind: 'backup-create', state: 'unknown', actorId: 'test:admin', scope: {}, acceptedAt: 1000, updatedAt: 2000, stage: 'Process ended before confirmation.', result: null }, observedAt: Date.now() } };
  });
  await page.goto('/operations/backups');
  await page.getByRole('button', { name: 'Jetzt sichern', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Aktion nicht bestätigt');
  await page.getByRole('link', { name: /^Auftrag .* prüfen$/ }).click();
  await expect(page.getByRole('heading', { name: 'Ergebnis unbekannt – keine automatische Wiederholung' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Ergebnis unbekannt – keine automatische Wiederholung' })).toBeVisible();
  expect(requests.filter(request => request.path === '/api/operations/backup')).toHaveLength(1);
});

test('trade relation pages retain independent cursors and exact native money after reload', async ({ page }) => {
  const requests = await api(page, url => {
    if (url.pathname === '/api/trading/intents/detail') return { body: { entry: { ...entry, relatedRowsIncluded: false, money: { events: [], accountingStatus: 'unresolved', reportingCurrency: null, realizedPnl: null } }, observedAt: Date.now() } };
    if (url.pathname === '/api/trading/intents/relations') {
      const kind = url.searchParams.get('kind'); const next = url.searchParams.has('cursor');
      return { body: { entries: kind === 'orders' ? [{ id: next ? 'order-41' : 'order-1', role: 'entry', status: 'cancel_pending', quantity: '0.123456789123456789', filledQuantity: '0.01', reduceOnly: false }] : kind === 'money' ? [{ id: 'money-1', kind: 'fee', amount: '-0.0000000001', asset: 'BNB', valuationStatus: 'unresolved', source: 'original-provider', reportingAmount: null, reportingCurrency: null }] : [], observedAt: Date.now(), hasMore: kind === 'orders' && !next, nextCursor: kind === 'orders' && !next ? 'orders-page-2' : null } };
    }
  });
  await page.goto('/trading/trades/intent-1'); await expect(page.getByRole('region', { name: 'Alle Ordergenerationen', exact: true })).toContainText('order-1');
  await page.getByRole('button', { name: 'Weitere Orders', exact: true }).click(); await expect(page).toHaveURL(/ordersCursor=orders-page-2/);
  await page.reload(); await expect(page.getByRole('region', { name: 'Alle Ordergenerationen', exact: true })).toContainText('order-41');
  await expect(page.getByRole('region', { name: 'Originale Geldereignisse und FX', exact: true })).toContainText('-0.0000000001');
  await expect(page.getByRole('region', { name: 'Alle Ordergenerationen', exact: true })).toContainText('cancel_pending');
  expect(requests.every(request => request.method === 'GET')).toBe(true);
});

test('Paper market edits bind their version, keep decimals and cannot select a live account', async ({ page }) => {
  let market: any = { accountId: 'paper-1', symbol: 'BTCUSDT', markPrice: '60000', priceTick: '0.1', quantityStep: '0.001', minimumQuantity: '0.001', minimumNotional: '10', maxLeverage: 20, revision: 'a'.repeat(64), updatedAt: 1000 };
  const balance = { accountId: 'paper-1', equity: '10000', availableBalance: '9000', revision: 'b'.repeat(64), source: 'paper-contract-v1', reportingCurrency: 'USDT', updatedAt: 1000 };
  const requests = await api(page, (url, method, body) => {
    if (url.pathname === '/api/trading') return { body: { ...trading, accounts: [{ id: 'paper-1', name: 'Paper 1', exchange: 'paper', mode: 'paper' }, { id: 'live-1', name: 'Live 1', exchange: 'bybit', mode: 'live' }], activity: { ...trading.activity, paperMarkets: [market], paperAccounts: [balance] } } };
    if (url.pathname === '/api/trading/paper' && method === 'POST') { expect(body.baseMarketRevision).toBe('a'.repeat(64)); expect(body.market.markPrice).toBe('60000.00000001'); market = { ...market, ...body.market, revision: 'c'.repeat(64), updatedAt: 2000 }; return { body: { result: { market, balance, accountId: 'paper-1', simulated: true } } }; }
  });
  await page.goto('/trading/paper'); await page.getByRole('combobox', { name: 'Paper-Konto', exact: true }).selectOption('paper-1');
  await expect(page.getByRole('combobox', { name: 'Paper-Konto', exact: true }).locator('option')).toHaveCount(2);
  await page.getByRole('combobox', { name: 'Vorhandener Markt', exact: true }).selectOption('BTCUSDT'); await page.getByLabel('Markpreis', { exact: true }).fill('60000,00000001');
  await page.getByRole('button', { name: 'Paper-Markt speichern', exact: true }).click(); await expect(page.getByRole('dialog')).toContainText('Stop-/TP-Ereignisse');
  await page.getByRole('dialog').getByRole('button', { name: 'Paper-Änderung speichern' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Paper-Änderung bestätigt' })).toBeVisible(); await expect(page.getByLabel('Markpreis', { exact: true })).toHaveValue('60000.00000001');
  await page.getByLabel('Markpreis', { exact: true }).fill('61000'); market = { ...market, markPrice: '62000', revision: 'd'.repeat(64), updatedAt: 3000 };
  await expect(page.getByRole('region', { name: 'Paper-Markt Entwurf' })).toContainText('Serverstand geändert', { timeout: 10000 });
  await expect(page.getByLabel('Markpreis', { exact: true })).toHaveValue('61000'); await expect(page.getByRole('button', { name: 'Paper-Markt speichern', exact: true })).toBeDisabled();
  expect(requests.filter(request => request.method === 'POST')).toHaveLength(1);
});

test('Telegram settings observe normalization, retain unrelated fields and preserve a conflicting draft', async ({ page }) => {
  let config: any = { apiId: 1234, configRevision: 'config-1', targetChannel: '', sourceChannels: ['-1001234567'], sourceFilters: { '-1001234567': { regexPatterns: ['original'] } }, sourceAliases: {},
    forwardOptions: { maxConcurrency: 2, queueTimeoutSeconds: 255, forwardToTarget: false, sendCopy: false, removeCaption: true }, filters: { allowedTypes: ['text'], allowedKeywords: [], blockedKeywords: [], regexPatterns: ['global'] },
    xmlParsing: { enabled: true, primaryModel: 'fixture/model', fallbackModel: 'fixture/fallback', aiLimits, saveToFile: true, signalsDir: './original-signals', sourceTemplates: {} }, dupeBlocker: { enabled: false, cooldownHours: 0 } };
  const requests = await api(page, (url, method, body) => {
    if (url.pathname === '/api/config') {
      if (method === 'POST') { expect(body.sourceFilters['-1001234567']).toBeNull(); config = { ...body, sourceFilters: {}, configRevision: 'config-2', forwardOptions: { ...body.forwardOptions, queueTimeoutSeconds: 255 } }; return { body: { configuration: config, configRevision: 'config-2' } }; }
      return { body: config };
    }
    if (url.pathname === '/api/secrets') return { body: { secrets: { telegramApiHash: { configured: true }, openRouterApiKey: { configured: true } } } };
  });
  await page.goto('/signals/telegram');
  await page.getByLabel('Queue · Zeitlimit (Sekunden)', { exact: true }).fill('1');
  await page.getByText('Globaler Legacy-Signalweg · Quellen, Filter und Ausgabe', { exact: true }).click();
  await page.getByRole('combobox', { name: 'Konfigurierter Quellkanal', exact: true }).selectOption('-1001234567');
  await page.getByLabel('Globale Regex-Muster für diesen Kanal überschreiben', { exact: true }).uncheck();
  await page.getByRole('button', { name: 'Grundkonfiguration speichern', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Servernormalisierung nach dem Speichern', exact: true })).toContainText('255');
  await expect(page.getByLabel('Queue · Zeitlimit (Sekunden)', { exact: true })).toHaveValue('255');
  const saved = requests.find(request => request.path === '/api/config' && request.method === 'POST')!.body;
  expect(saved.xmlParsing.aiLimits.requestTimeoutMs).toBe(250000); expect(saved.xmlParsing.signalsDir).toBe('./original-signals'); expect(saved.xmlParsing.saveToFile).toBe(true); expect(saved.forwardOptions.forwardToTarget).toBe(false); expect(saved.dupeBlocker.cooldownHours).toBe(0);
  await page.getByLabel(/Telegram API Hash ·/).fill('telegram-hash-fixture'); await page.getByRole('button', { name: 'Telegram-/KI-Zugangsdaten speichern' }).click();
  expect(requests.filter(request => request.path === '/api/config' && request.method === 'POST')).toHaveLength(1);
  await page.getByLabel('Primärmodell', { exact: true }).fill('my/draft'); config = { ...config, configRevision: 'config-3', targetChannel: '@changed_target' };
  await expect(page.getByRole('region', { name: 'Grundkonfiguration Entwurf' })).toContainText('Serverstand geändert', { timeout: 10000 });
  await expect(page.getByLabel('Primärmodell', { exact: true })).toHaveValue('my/draft'); await expect(page.getByRole('button', { name: 'Grundkonfiguration speichern', exact: true })).toBeDisabled();
  expect(requests.some(request => ['/api/operations', '/api/access', '/api/runtime-settings', '/api/exchanges/catalog'].includes(request.path))).toBe(false);
  expect(requests.filter(request => request.path === '/api/trading').every(request => request.query === '?view=overview')).toBe(true);
});

test('AI lab requires preview and consent, invalidates edits and shows the durable result', async ({ page }) => {
  const source = 'LONG BTCUSDT entry 60000 target 62000 stoploss 59000'; let requestedId = '';
  const requests = await api(page, (url, method, body) => {
    if (url.pathname === '/api/workflow/parser-test' && method === 'GET') return { body: { paths: [], limits: aiLimits, usageDay: '2026-09-05', usage: { requestCount: 1, usedTokens: 100, reservedTokens: 20 }, queue: { running: 0, queued: 0, maxConcurrency: 2, paused: false }, observedAt: Date.now() } };
    if (url.pathname === '/api/workflow/parser-test/preview') return { body: { provider: 'OpenRouter', sourceChars: body.sourceText.length, sourceBytes: body.sourceText.length, sourceSha256: 'source-hash', promptSha256: 'prompt-hash', models: { primaryModel: 'fixture/model' }, limits: aiLimits, totalTimeoutMs: 30000, previewHash: 'preview-hash', observedAt: Date.now(), externalDataPolicyAccepted: true, providerConfigured: true } };
    if (url.pathname === '/api/workflow/parser-test' && method === 'POST') { requestedId = body.jobId; return { status: 202, body: { job: { id: requestedId } } }; }
    if (url.pathname === '/api/operations/jobs') return { body: { job: { id: requestedId, kind: 'parser-test', state: 'succeeded', actorId: 'test:admin', scope: {}, acceptedAt: 1000, updatedAt: 2000, stage: 'Completed', result: { stages: ['provider-response', 'xml-validation', 'source-grounding'], tradeExecuted: false, deliveryCreated: false, xml: '<signal>fixture</signal>', provenance: { model: 'fixture/model' } } }, observedAt: Date.now() } };
  });
  await page.goto('/workflows/tests?mode=ai');
  await page.getByLabel('Quelltext', { exact: true }).fill(source);
  await page.getByRole('button', { name: 'Provideraufruf vorbereiten' }).click();
  await expect(page.getByRole('button', { name: 'KI-Test einmal beauftragen' })).toBeDisabled();
  await page.getByLabel(/Ich stimme der Übermittlung/).check();
  await page.getByLabel('Quelltext', { exact: true }).fill(source + ' changed');
  await expect(page.getByRole('heading', { name: 'Provideraufruf prüfen' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Provideraufruf vorbereiten' }).click();
  await page.getByLabel(/Ich stimme der Übermittlung/).check();
  await page.getByRole('button', { name: 'KI-Test einmal beauftragen' }).click();
  await expect(page.getByRole('heading', { name: 'Auftragsannahme' })).toBeVisible();
  expect(page.url()).not.toContain('LONG');
  page.on('dialog', dialog => dialog.accept());
  await page.getByRole('link', { name: /^Auftrag .* prüfen$/ }).click();
  await page.getByRole('button', { name: 'Verwerfen und verlassen' }).click();
  await expect(page.getByRole('heading', { name: 'KI- und Validierungsnachweis' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Abschluss belegt' })).toBeVisible();
  expect(requests.filter(request => request.method === 'POST' && request.path === '/api/workflow/parser-test')).toHaveLength(1);
  expect(requests.some(request => request.method === 'POST' && /trading|outbox/.test(request.path))).toBe(false);
});
