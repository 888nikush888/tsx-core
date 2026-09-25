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
import { seedTradingFixtures } from './trading_fixtures.js';
import { setupInternalTlsTest } from './fixtures/internal_tls_test.js';

const tlsFixture = await setupInternalTlsTest();
const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-ui-commands-'));
if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(directory).startsWith('tsx-ui-commands-')) throw new Error('Unsafe fixture cleanup.');
const admin = 'ui-command-admin-'.repeat(3); const viewer = 'ui-command-viewer-'.repeat(3);
const oldEnvironment = { ...process.env };
let server = null;
async function accountEvidenceHttpReads(base) {
  await seedTradingFixtures();
  const database = getDatabase(); const now = Date.now(); const id = 'd'.repeat(64);
  const original = { reservations: [{ intentId: 'original-intent-a', sourceHash: 'source-a' }, { intentId: 'original-intent-b', sourceHash: 'source-b' }] };
  await database.run(`INSERT INTO trading_risk_observations(id,account_id,account_fingerprint,credential_generation,entry_epoch,observed_at,expires_at,utc_day,evidence_json,recorded_at)
    VALUES (?,'paper-default','paper:paper-default',NULL,'fixture-epoch',?,?,?,?,?)`,
  [id, now - 1, now + 60000, new Date(now).setUTCHours(0, 0, 0, 0), JSON.stringify(original), now]);
  await database.run('INSERT INTO trading_risk_current(account_id,observation_id) VALUES (?,?)', ['paper-default', id]);
  const getEvidence = (query, token = viewer) => fetch(`${base}/api/trading/accounts/evidence?${query}`, { headers: { Authorization: `Bearer ${token}` } });
  const overview = await getEvidence('accountId=paper-default&kind=overview');
  assert.equal(overview.status, 200); assert.equal((await overview.json()).account.id, 'paper-default');
  const reservations = await getEvidence('accountId=paper-default&kind=reservations&limit=1');
  assert.equal(reservations.status, 200); const first = await reservations.json();
  assert.equal(first.entries[0].intentId, 'original-intent-a'); assert.equal(first.hasMore, true);
  const next = await getEvidence(`accountId=paper-default&kind=reservations&limit=1&cursor=${encodeURIComponent(first.nextCursor)}`);
  assert.equal(next.status, 200); assert.equal((await next.json()).entries[0].intentId, 'original-intent-b');
  const history = await getEvidence('accountId=paper-default&kind=history');
  assert.equal(history.status, 200); assert.deepEqual((await history.json()).entries, []);
  assert.equal((await getEvidence('accountId=paper-default&kind=unsupported')).status, 400);
  assert.equal((await getEvidence('accountId=missing-account&kind=overview')).status, 404);
  assert.equal((await getEvidence('accountId=paper-default&kind=overview', 'invalid-token')).status, 401);
  assert.deepEqual(JSON.parse((await database.get('SELECT evidence_json FROM trading_risk_observations WHERE id=?', [id])).evidence_json), original,
    'All viewer evidence variants read the original observation without changing it.');
}
try {
  process.env.DASHBOARD_AUTH_MODE = 'token'; process.env.DASHBOARD_ADMIN_TOKEN = admin; process.env.DASHBOARD_VIEWER_TOKEN = viewer;
  process.env.OPENROUTER_API_KEY = 'fixture-key-no-network';
  await initDb(path.join(directory, 'fixture.db'));
  const calls = { backup: 0, drill: 0, restore: 0, restart: 0 }; const audits = [];
  const config = { xmlParsing: { primaryModel: 'fixture/model', fallbackModel: 'fixture/fallback', externalDataPolicyAccepted: true,
    aiLimits: { ...DEFAULT_AI_LIMITS, primaryAttempts: 1, fallbackAttempts: 0, dailyRequestLimit: 1, backoffMs: 0 } } };
  const store = new UiOperationStore(path.join(directory, 'jobs'));
  const app = { config, state: { isRunning: false }, getQueueState: () => ({ running: 0, queued: 0, maxConcurrency: 2, paused: false }),
    startForwarding: () => Promise.resolve(), stopForwarding: () => Promise.resolve(), reloadConfig: () => undefined, applyRuntimeConfig: () => undefined,
    auditTrail: { record: event => Promise.resolve(audits.push(event)), snapshot: () => ({ healthy: true }) }, uiOperations: store,
    runBackupNow: () => { calls.backup++; return Promise.resolve('backup-2026-fixture'); },
    runBackupDrill: () => { calls.drill++; return Promise.resolve({ artifactSha256: 'fixture', runtimeDisabled: true, isolation: 'temporary-child-network-apis-disabled' }); },
    restoreBackup: () => { calls.restore++; return Promise.resolve({ previousDatabase: 'fixture-rollback', previousConfig: null }); }, requestRestart: () => { calls.restart++; },
  };
  server = startWebServer(0, app); await once(server, 'listening');
  const base = `https://127.0.0.1:${server.address().port}`;
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
  let recoveryCalls = 0;
  app.recoverOffsiteBackup = function (objectName) {
    assert.equal(this, app, 'Deferred recovery must retain the application receiver.');
    assert.equal(objectName, 'backup-2026-fixture.tgfb');
    recoveryCalls++;
    return Promise.resolve('backup-2026-recovered');
  };
  const recover = (jobId, token = admin, confirmation = 'recover-offsite-backup') =>
    post('/api/backups/recover-offsite', { jobId, objectName: 'backup-2026-fixture.tgfb' }, confirmation, token);
  assert.equal((await recover('recovery-fixture-job-1', viewer)).status, 403);
  assert.equal((await recover('recovery-fixture-job-1', admin, null)).status, 412);
  assert.equal(recoveryCalls, 0);
  response = await recover('recovery-fixture-job-1'); assert.equal(response.status, 202);
  assert.equal((await response.json()).created, true);
  const recovered = await waitJob('recovery-fixture-job-1');
  assert.equal(recovered.state, 'succeeded');
  assert.deepEqual(recovered.result, { artifactName: 'backup-2026-recovered' });
  response = await recover('recovery-fixture-job-1'); assert.equal(response.status, 202);
  assert.equal((await response.json()).created, false);
  assert.equal(recoveryCalls, 1, 'Repeated recovery job must not repeat the external operation.');
  app.recoverOffsiteBackup = () => Promise.reject(new Error('Fixture recovery download failed.'));
  assert.equal((await recover('recovery-failed-job-1')).status, 202);
  const failedRecovery = await waitJob('recovery-failed-job-1');
  assert.equal(failedRecovery.state, 'failed');
  assert.equal(failedRecovery.result, null);
  assert.match(failedRecovery.error, /Fixture recovery download failed/);
  const originalRun = store.run;
  const { promise: recoveryGate, resolve: releaseRecovery } = Promise.withResolvers();
  store.run = async function (id, operation, restart) {
    await recoveryGate;
    return originalRun.call(this, id, operation, restart);
  };
  try {
    assert.equal((await recover('recovery-unavailable-job-1')).status, 202);
    delete app.recoverOffsiteBackup;
    releaseRecovery();
    const unavailableRecovery = await waitJob('recovery-unavailable-job-1');
    assert.equal(unavailableRecovery.state, 'failed');
    assert.equal(unavailableRecovery.result, null);
    assert.match(unavailableRecovery.error, /Off-site backup recovery is unavailable/);
  } finally {
    releaseRecovery();
    store.run = originalRun;
  }
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
  response = await post('/api/workflow/parser-test', { ...request, externalDataConsent: true, sourceText: `${sourceText} changed` }, 'run-parser-test'); assert.equal(response.status, 409);
  response = await post('/api/workflow/parser-test', { ...request, externalDataConsent: true }, 'run-parser-test', viewer); assert.equal(response.status, 403);
  app.startupAuthority = { canMutate: () => false, snapshot: () => ({ phase: 'blocked', reason: 'fixture', mutationHolds: [], pendingGates: [] }) };
  response = await post('/api/workflow/parser-test', { ...request, externalDataConsent: true }, 'run-parser-test'); assert.equal(response.status, 503);
  delete app.startupAuthority;
  const prepared = await prepareUiParserTest(config, { sourceText }); let providerCalls = 0;
  const fixtureParser = (text, template, models, options) => parseSignalToXml(text, template, models, { ...options, requestCompletion: () => {
    providerCalls++;
    return Promise.resolve({ model: 'fixture/model', choices: [{ finish_reason: 'stop', message: { content: '<signal><action>LONG</action><pair>BTCUSDT</pair><entry_range><min>60000</min><max>60000</max></entry_range><targets><target id="1">62000</target></targets><stoploss>59000</stoploss><leverage>3</leverage></signal>' } }], usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 } });
  } });
  const result = await runUiParserTest(prepared, fixtureParser); assert.equal(result.tradeExecuted, false); assert.equal(result.deliveryCreated, false); assert.equal(providerCalls, 1);
  assert.equal((await getAiUsage(new Date().toISOString().slice(0, 10))).usedTokens, 100);
  await assert.rejects(runUiParserTest(prepared, fixtureParser), /budget_exhausted/); assert.equal(providerCalls, 1, 'Persistent global quota applies before the provider request.');
  const largeXml = '💶\\"\u0001'.repeat(24_000);
  const bounded = await runUiParserTest(prepared, () => Promise.resolve(({ xml: largeXml, provenance: result.provenance })));
  assert.equal(bounded.xmlTruncated, true); assert.ok(Buffer.byteLength(JSON.stringify(bounded.xml)) <= 24_000);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) < 60_000, 'Escaped multi-byte output leaves room in the 64 KiB durable receipt.');
  assert.ok(!/[\uD800-\uDBFF]$/u.test(bounded.xml), 'Truncation preserves Unicode character boundaries.');
  assert.equal((await getDatabase().get('SELECT COUNT(*) AS count FROM trading_trade_intents')).count, 0);
  assert.equal((await getDatabase().get('SELECT COUNT(*) AS count FROM pending_tasks')).count, 0);
  await accountEvidenceHttpReads(base);
  console.log('Operator job HTTP roles, deduplication, paging, preview binding and real parser quota path passed with a fixture provider.');
} finally {
  if (server) await stopWebServer(); await closeDb();
  await rm(directory, { recursive: true, force: true });
  for (const name of Object.keys(process.env)) if (!(name in oldEnvironment)) delete process.env[name];
  Object.assign(process.env, oldEnvironment);
  await tlsFixture.cleanup();
}
