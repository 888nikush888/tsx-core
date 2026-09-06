import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { closeDb, initDb, getAiUsage, getDatabase } from '../src/db.js';
import { startWebServer, stopWebServer } from '../src/web_server.js';
import { UiOperationStore } from '../src/ui_operation_store.js';
import { prepareUiParserTest, runUiParserTest } from '../src/ui_parser_lab.js';
import { DEFAULT_AI_LIMITS, parseSignalToXml } from '../src/signal_parser.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-ui-commands-'));
if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(directory).startsWith('tsx-ui-commands-')) throw new Error('Unsafe fixture cleanup.');
const admin = 'ui-command-admin-'.repeat(3); const viewer = 'ui-command-viewer-'.repeat(3);
const oldEnvironment = { ...process.env };
let server;
try {
  process.env.DASHBOARD_AUTH_MODE = 'token'; process.env.DASHBOARD_ADMIN_TOKEN = admin; process.env.DASHBOARD_VIEWER_TOKEN = viewer;
  process.env.OPENROUTER_API_KEY = 'fixture-key-no-network';
  await initDb(path.join(directory, 'fixture.db'));
  const calls = { backup: 0, drill: 0, restore: 0, restart: 0 }; const audits = [];
  const config = { xmlParsing: { primaryModel: 'fixture/model', fallbackModel: 'fixture/fallback', externalDataPolicyAccepted: true,
    aiLimits: { ...DEFAULT_AI_LIMITS, primaryAttempts: 1, fallbackAttempts: 0, dailyRequestLimit: 1, backoffMs: 0 } } };
  const store = new UiOperationStore(path.join(directory, 'jobs'));
  const app = { config, state: { isRunning: false }, getQueueState: () => ({ running: 0, queued: 0, maxConcurrency: 2, paused: false }),
    startForwarding: async () => {}, stopForwarding: async () => {}, reloadConfig: () => {}, applyRuntimeConfig: () => {},
    auditTrail: { record: async event => audits.push(event), snapshot: () => ({ healthy: true }) }, uiOperations: store,
    runBackupNow: async () => { calls.backup++; return 'backup-2026-fixture'; },
    runBackupDrill: async () => { calls.drill++; return { artifactSha256: 'fixture', runtimeDisabled: true, isolation: 'temporary-child-network-apis-disabled' }; },
    restoreBackup: async () => { calls.restore++; return { previousDatabase: 'fixture-rollback', previousConfig: null }; }, requestRestart: () => { calls.restart++; },
  };
  server = startWebServer(0, app); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body, confirmation, token = admin, extra = {}) => fetch(`${base}${route}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Requested-With': 'forwarder-dashboard', ...(confirmation ? { 'X-Destructive-Confirmation': confirmation } : {}), ...extra }, body: JSON.stringify(body) });
  const waitJob = async id => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const job = await store.get(id); if (['succeeded', 'failed', 'awaiting-restart'].includes(job?.state)) return job;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Fixture job ${id} did not settle.`);
  };
  let response = await post('/api/operations/backup-drill', { jobId: 'drill-fixture-job-1', name: 'backup-2026-fixture' }, null);
  assert.equal(response.status, 412);
  response = await post('/api/operations/backup-drill', { jobId: 'drill-fixture-job-1', name: 'backup-2026-fixture' }, 'run-backup-drill', viewer);
  assert.equal(response.status, 403); assert.equal(calls.drill, 0);
  const command = () => post('/api/operations/backup-drill', { jobId: 'drill-fixture-job-1', name: 'backup-2026-fixture' }, 'run-backup-drill');
  response = await command(); assert.equal(response.status, 202); await response.json();
  assert.equal((await waitJob('drill-fixture-job-1')).state, 'succeeded');
  assert.equal((await command()).status, 202); assert.equal(calls.drill, 1, 'Repeated operator key must never repeat the drill.');
  response = await post('/api/operations/backup', {}, null, admin, { 'X-Operator-Job-ID': 'backup-fixture-job-1' }); assert.equal(response.status, 202);
  assert.equal((await waitJob('backup-fixture-job-1')).result.artifactName, 'backup-2026-fixture');
  response = await post('/api/backups/restore', { jobId: 'restore-fixture-job-1', name: 'backup-2026-fixture' }, 'restore-backup'); assert.equal(response.status, 200);
  response = await post('/api/backups/restore', { jobId: 'restore-fixture-job-1', name: 'backup-2026-fixture' }, 'restore-backup'); assert.equal(response.status, 202);
  assert.equal(calls.restore, 1); assert.equal(calls.restart, 1);
  response = await fetch(`${base}/api/operations/jobs?limit=1`, { headers: { Authorization: `Bearer ${viewer}` } }); assert.equal(response.status, 200);
  const first = await response.json(); assert.equal(first.jobs.length, 1); assert.equal(first.hasMore, true);
  response = await fetch(`${base}/api/operations/jobs?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`, { headers: { Authorization: `Bearer ${viewer}` } });
  const second = await response.json(); assert.notEqual(second.jobs[0].id, first.jobs[0].id); assert.equal(second.observedAt, first.observedAt);
  const sourceText = 'LONG BTCUSDT entry 60000 targets 62000 stoploss 59000 leverage 3';
  response = await post('/api/workflow/parser-test/preview', { sourceText }); assert.equal(response.status, 200);
  const preview = await response.json(); assert.equal(preview.sourceChars, sourceText.length);
  assert.equal(JSON.stringify(audits).includes(sourceText), false, 'Operator test source text must not leak into request audit.');
  const request = { sourceText, jobId: 'parser-fixture-job-1', previewHash: preview.previewHash, previewObservedAt: preview.observedAt };
  response = await post('/api/workflow/parser-test', request, 'run-parser-test'); assert.equal(response.status, 412, 'Per-test consent is mandatory.');
  response = await post('/api/workflow/parser-test', { ...request, externalDataConsent: true, sourceText: sourceText + ' changed' }, 'run-parser-test'); assert.equal(response.status, 409);
  response = await post('/api/workflow/parser-test', { ...request, externalDataConsent: true }, 'run-parser-test', viewer); assert.equal(response.status, 403);
  app.startupAuthority = { canMutate: () => false, snapshot: () => ({ phase: 'blocked', reason: 'fixture', mutationHolds: [], pendingGates: [] }) };
  response = await post('/api/workflow/parser-test', { ...request, externalDataConsent: true }, 'run-parser-test'); assert.equal(response.status, 503);
  delete app.startupAuthority;
  const prepared = await prepareUiParserTest(config, { sourceText }); let providerCalls = 0;
  const fixtureParser = (text, template, models, options) => parseSignalToXml(text, template, models, { ...options, requestCompletion: async () => {
    providerCalls++;
    return { model: 'fixture/model', choices: [{ finish_reason: 'stop', message: { content: '<signal><action>LONG</action><pair>BTCUSDT</pair><entry_range><min>60000</min><max>60000</max></entry_range><targets><target id="1">62000</target></targets><stoploss>59000</stoploss><leverage>3</leverage></signal>' } }], usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 } };
  } });
  const result = await runUiParserTest(prepared, fixtureParser); assert.equal(result.tradeExecuted, false); assert.equal(result.deliveryCreated, false); assert.equal(providerCalls, 1);
  assert.equal((await getAiUsage(new Date().toISOString().slice(0, 10))).usedTokens, 100);
  await assert.rejects(runUiParserTest(prepared, fixtureParser), /budget_exhausted/); assert.equal(providerCalls, 1, 'Persistent global quota applies before the provider request.');
  const largeXml = '💶\\"\u0001'.repeat(24_000);
  const bounded = await runUiParserTest(prepared, async () => ({ xml: largeXml, provenance: result.provenance }));
  assert.equal(bounded.xmlTruncated, true); assert.ok(Buffer.byteLength(JSON.stringify(bounded.xml)) <= 24_000);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) < 60_000, 'Escaped multi-byte output leaves room in the 64 KiB durable receipt.');
  assert.ok(!/[\uD800-\uDBFF]$/.test(bounded.xml), 'Truncation preserves Unicode character boundaries.');
  assert.equal((await getDatabase().get('SELECT COUNT(*) AS count FROM trading_trade_intents')).count, 0);
  assert.equal((await getDatabase().get('SELECT COUNT(*) AS count FROM pending_tasks')).count, 0);
  console.log('Operator job HTTP roles, deduplication, paging, preview binding and real parser quota path passed with a fixture provider.');
} finally {
  if (server) await stopWebServer(); await closeDb();
  await rm(directory, { recursive: true, force: true });
  for (const name of Object.keys(process.env)) if (!(name in oldEnvironment)) delete process.env[name];
  Object.assign(process.env, oldEnvironment);
}
