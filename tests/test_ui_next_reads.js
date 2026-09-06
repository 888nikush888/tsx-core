import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb, saveSignal } from '../src/db.js';
import { seedTradingFixtures } from './trading_fixtures.js';
import { createTradingIntent, listTradingStrategies, setTradingRoute, getTradingAccount, updateTradingAccountConfiguration } from '../src/trading_repository.js';
import { validateSignalXml } from '../src/signal_schema.js';
import { listTradeJournalPage, updateTradeJournalReview } from '../src/trade_journal.js';
import { uiIngressDetail, uiSignalPage } from '../src/ui_signal_reads.js';
import { uiSignalOriginal } from '../src/ui_signal_original.js';
import { uiAttention } from '../src/ui_attention.js';
import { uiCockpit } from '../src/ui_cockpit.js';
import { uiIngressRelations } from '../src/ui_ingress_relations.js';
import { uiAccountDetail, uiTradingPage, uiTradeSafety } from '../src/ui_trading_reads.js';
import { uiTradeRelationPage, uiJournalDetail, uiJournalSummary } from '../src/ui_trade_relations.js';
import { recordMoneyEvent } from '../src/trading_money_ledger.js';
import { uiAccountEvidence, uiAccountReservations, uiAccountHistory } from '../src/ui_account_evidence.js';
import { moneyValueFromDecimal } from '../src/trading_money_value.js';
import { TRADING_ORDER_STATUSES } from '../src/ui_contracts.js';
import { getUiWorkflowDraft, saveUiWorkflowDraft, deleteUiWorkflowDraft } from '../src/ui_workflow_drafts.js';
import { createWorkflowResourceDraft, updateWorkflowResourceDraft, publishWorkflowResource, getActiveWorkflow } from '../src/workflow_repository.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-ui-next-'));
async function testIngressRelations(database) {
  const now = Date.now() - 1000; const workIds = ['work-1'];
  for (let index = 0; index < 105; index++) {
    const id = `album-${index}-${'long'.repeat(40)}`; workIds.push(id);
    await database.run(`INSERT INTO incoming_work(id,chat_id,message_id,status,created_at,updated_at) VALUES (?,'ui-test',?,'routed',?,?)`, [id, 2000 + index, now, now]);
    await saveSignal(`album-signal-${index}`, 'ui-test', 2000 + index, 'original', 'original');
    await database.run('INSERT INTO signal_parser_attempts(id,signal_id,provenance_json,created_at) VALUES (?,?,?,?)', [`attempt-${index}`, `album-signal-${index}`, JSON.stringify({ model: 'original-model', promptTokens: 0, completionTokens: 1, rawResponse: 'PRIVATE_RAW_RESULT' }), now]);
  }
  await database.run(`INSERT INTO incoming_album_groups(id,chat_id,media_group_id,work_ids_json,config_json,ready_at,status) VALUES ('album-ui','ui-test','telegram-album',?,'{}',?,'completed')`, [JSON.stringify(workIds), now]);
  for (const kind of ['members', 'signals', 'attempts']) {
    const first = await uiIngressRelations('work-1', kind, new URLSearchParams({ limit: '100' }));
    const next = await uiIngressRelations('work-1', kind, new URLSearchParams({ limit: '100', cursor: first.nextCursor }));
    assert.equal(first.entries.length, 100); assert.equal(next.entries.length, kind === 'attempts' ? 5 : 6);
    assert.equal(new Set([...first.entries, ...next.entries].map(row => row.id)).size, kind === 'attempts' ? 105 : 106);
    assert.doesNotMatch(JSON.stringify(first), /PRIVATE_RAW_RESULT|config_json|message_json/);
    await assert.rejects(uiIngressRelations(workIds[1], kind, new URLSearchParams({ limit: '100', cursor: first.nextCursor })), /match/);
  }
  const albums = await uiIngressRelations('work-1', 'albums', new URLSearchParams());
  assert.equal(albums.entries[0].memberCount, 106); assert.equal(albums.entries[0].workIds, undefined);
  assert.equal((await uiIngressRelations('work-1', 'attempts', new URLSearchParams())).entries[0].promptTokens, 0);
  for (const kind of ['plans', 'runs', 'branches', 'fallbacks', 'candidates', 'intents', 'tasks']) {
    const page = await uiIngressRelations('work-1', kind, new URLSearchParams()); assert.ok(Array.isArray(page.entries));
  }
  assert.equal(await uiIngressRelations('missing', 'signals', new URLSearchParams()), null);
  await assert.rejects(uiIngressRelations('work-1', 'constructor', new URLSearchParams()), /Unsupported/);
}
async function testAccountEvidence(database) {
  const now = Date.now(); const account = await getTradingAccount('paper-default');
  const originalIntents = await database.all('SELECT id FROM trading_trade_intents ORDER BY id LIMIT 55');
  const reservations = originalIntents.map(intent => ({ intentId: intent.id, sourceHash: 'original-source',
    amounts: { status: 'complete', reportingCurrency: 'USDT', additionalRisk: '0.000000000000000123', additionalRiskValue: moneyValueFromDecimal('0.000000000000000123') },
    input: { markPrice: '60000.0000000001', stopPrice: '59000', protectionProven: true }, entries: [{ private: 'PRIVATE_LARGE_ORDER_SOURCE' }] }));
  const observationId = 'e'.repeat(64);
  await database.run(`INSERT INTO trading_risk_observations (id,account_id,account_fingerprint,credential_generation,entry_epoch,observed_at,expires_at,utc_day,evidence_json,recorded_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`, [observationId, account.id, 'paper:paper-default', account.credentialGeneration, 'old-epoch', now - 61000, now - 1000,
  new Date(now - 61000).setUTCHours(0, 0, 0, 0), JSON.stringify({ reportingCurrency: 'USDT', reservations, source: 'PRIVATE_RAW_SOURCE' }), now]);
  await database.run('INSERT INTO trading_risk_current(account_id,observation_id,balance_reason) VALUES (?,?,?)', [account.id, observationId, 'Balance not observed']);
  const overview = await uiAccountEvidence(account.id);
  assert.equal(overview.risk.timestampFresh, false); assert.equal(overview.risk.identityMatches, true); assert.equal(overview.risk.reservationCount, 55);
  assert.equal(overview.risk.equity, null); assert.equal(overview.daily.historyCompleteness, 'unproven'); assert.equal(overview.risk.balanceSourceObservationId, observationId);
  const first = await uiAccountReservations(account.id, new URLSearchParams({ observationId, limit: '50' }));
  const next = await uiAccountReservations(account.id, new URLSearchParams({ observationId, limit: '50', cursor: first.nextCursor }));
  assert.equal(first.entries.length, 50); assert.equal(next.entries.length, 5); assert.equal(first.observedAt, next.observedAt);
  assert.equal(new Set([...first.entries, ...next.entries].map(item => item.intentId)).size, 55);
  assert.equal(first.entries[0].amounts.additionalRiskValue.decimal, '0.000000000000000123');
  assert.equal(first.entries[0].markPrice, '60000.0000000001'); assert.doesNotMatch(JSON.stringify(first), /PRIVATE_|fingerprint|old-epoch/);
  await assert.rejects(uiAccountReservations(account.id, new URLSearchParams({ observationId, limit: '20', cursor: first.nextCursor })), /match/);
  await database.run(`INSERT INTO trading_accounts(id,name,exchange,mode,status,enabled,external_account_id,credential_ref,created_at,updated_at)
    VALUES ('evidence-history','History','bybit','testnet','unverified',0,?,'fixture:history',1,1)`, ['b'.repeat(64)]);
  for (let index = 0; index < 55; index++) await database.run(`INSERT INTO trading_history_checkpoints(account_id,account_fingerprint,source,provider_symbol,revision,checkpoint_json,updated_at)
    VALUES ('evidence-history',?,'fills',?,1,?,?)`, ['b'.repeat(64), `market-${index}`, JSON.stringify({ completeness: 'unknown', cursor: 'PRIVATE_PROVIDER_CURSOR', reason: 'history_pending', scannedThrough: null, coverage: null }), now]);
  const before = await database.all('SELECT * FROM trading_history_checkpoints ORDER BY rowid');
  const history = await uiAccountHistory('evidence-history', new URLSearchParams({ limit: '50' }));
  const historyNext = await uiAccountHistory('evidence-history', new URLSearchParams({ limit: '50', cursor: history.nextCursor }));
  assert.equal(history.entries.length, 50); assert.equal(historyNext.entries.length, 5); assert.equal(history.entries[0].scannedThrough, null);
  assert.equal(history.entries[0].cursorPresent, 1); assert.doesNotMatch(JSON.stringify(history), /PRIVATE_|bbbbbbbb/);
  assert.deepEqual(await database.all('SELECT * FROM trading_history_checkpoints ORDER BY rowid'), before, 'UI history reads never initialize, align or advance engine checkpoints.');
  assert.equal(await uiAccountEvidence('not-an-account'), null);
}
try {
  await initDb(path.join(directory, 'test.db'));
  await seedTradingFixtures();
  const database = getDatabase();
  for (let index = 0; index < 55; index++) await database.run("INSERT INTO trading_risk_events(id,severity,code,details_json,created_at) VALUES (?,'warning','ORIGINAL_RISK',?,1000)", [`attention-${String(index).padStart(3, '0')}`, JSON.stringify({ secret: 'PRIVATE_RISK_DETAILS', big: 'x'.repeat(100000) })]);
  await database.run("INSERT INTO trading_account_incidents(id,account_id,fingerprint,category,severity,message,details_json,status,occurrence_count,first_seen_at,last_seen_at) VALUES ('attention-critical','paper-default',?,'protection','critical','Protection uncertain','{}','open',1,2000,2001)", ['f'.repeat(64)]);
  const attentionFirst = await uiAttention(new URLSearchParams({ limit: '50' }));
  const attentionRest = await uiAttention(new URLSearchParams({ limit: '50', cursor: attentionFirst.nextCursor }));
  assert.equal(attentionFirst.entries[0].id, 'attention-critical', 'Critical protection incident precedes older warning events.');
  assert.equal(attentionFirst.total, 56); assert.equal(attentionFirst.entries.length, 50); assert.equal(attentionRest.entries.length, 6);
  assert.equal(new Set([...attentionFirst.entries, ...attentionRest.entries].map(row => row.id)).size, 56);
  assert.ok(Buffer.byteLength(JSON.stringify(attentionFirst)) < 100000); assert.doesNotMatch(JSON.stringify(attentionFirst), /PRIVATE_RISK_DETAILS/);
  assert.equal(attentionFirst.entries[1].nextRead.href, '/trading/risk-events?objectId=attention-000');
  await assert.rejects(uiAttention(new URLSearchParams({ limit: '20', cursor: attentionFirst.nextCursor })), /match/);
  const riskPage = await uiTradingPage('risk-events', new URLSearchParams({ limit: '50', status: 'unacknowledged' }));
  const riskRest = await uiTradingPage('risk-events', new URLSearchParams({ limit: '50', status: 'unacknowledged', cursor: riskPage.nextCursor }));
  assert.equal(riskPage.entries.length, 50); assert.equal(riskRest.entries.length, 5); assert.equal(riskPage.entries[0].acknowledgedAt, null);
  assert.equal((await uiTradingPage('risk-events', new URLSearchParams({ objectId: 'attention-000' }))).entries.length, 1);
  await database.run("UPDATE trading_risk_events SET acknowledged_at=3000 WHERE id='attention-000'");
  assert.equal((await uiTradingPage('risk-events', new URLSearchParams({ status: 'acknowledged' }))).entries.length, 1);
  await database.run("DELETE FROM trading_risk_events WHERE id LIKE 'attention-%'");
  await database.run("DELETE FROM trading_account_incidents WHERE id='attention-critical'");
  const longOriginal = '🎯'.repeat(20005);
  await saveSignal('text-original', 'old-channel', 123, longOriginal, '0.000000000000001', { model: 'original-model' });
  let textCursor; const textParts = [];
  do {
    const result = await uiSignalOriginal(new URLSearchParams({ id: 'text-original', ...(textCursor ? { cursor: textCursor } : {}) }));
    assert.ok([...result.text].length <= 10000); assert.equal(result.totalCharacters, 20005); assert.equal(result.model, 'original-model');
    textParts.push(result.text); textCursor = result.nextCursor;
    if (textCursor) await assert.rejects(uiSignalOriginal(new URLSearchParams({ id: 'text-original', field: 'normalized', cursor: textCursor })), /match/);
  } while (textCursor);
  assert.equal(textParts.join(''), longOriginal, 'Bounded original chunks preserve Unicode without silently truncating legacy data.');
  assert.equal((await uiSignalOriginal(new URLSearchParams({ id: 'text-original', field: 'normalized' }))).text, '0.000000000000001');
  assert.equal(await uiSignalOriginal(new URLSearchParams({ id: 'absent' })), null);
  await assert.rejects(uiSignalOriginal(new URLSearchParams({ id: '1', kind: 'messages', field: 'xml' })), /Invalid/);
  for (let index = 0; index < 105; index++) await database.run("INSERT INTO incoming_messages(chat_id,message_id,text,type,status,created_at) VALUES ('legacy-only',?,?,'text','processed',1000)", [index, longOriginal]);
  const cached = await uiSignalPage('messages', new URLSearchParams({ channelId: 'legacy-only', limit: '100' }));
  const cachedRest = await uiSignalPage('messages', new URLSearchParams({ channelId: 'legacy-only', limit: '100', cursor: cached.nextCursor }));
  assert.equal(cached.entries.length, 100); assert.equal(cachedRest.entries.length, 5);
  assert.equal(new Set([...cached.entries, ...cachedRest.entries].map(row => row.id)).size, 105);
  assert.equal((await uiSignalOriginal(new URLSearchParams({ id: String(cached.entries[0].id), kind: 'messages' }))).totalCharacters, 20005);
  const ordersSchema = (await database.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='trading_orders'")).sql;
  const storedOrderStates = [...ordersSchema.match(/CHECK\s*\(status IN\s*\(([^)]+)\)/)[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
  assert.deepEqual([...TRADING_ORDER_STATUSES], storedOrderStates, 'Order filters must use the persisted order lifecycle, not intent/provider status names.');
  const strategy = (await listTradingStrategies()).find(item => item.status === 'published');
  await setTradingRoute({ channelId: 'ui-test', strategyVersionId: strategy.id, accountId: 'paper-default', enabled: true });
  const xml = '<signal><action>LONG</action><pair>BTCUSDT</pair><entry_range><min>60000</min><max>61000</max></entry_range><targets><target id="1">62000</target></targets><stoploss>59000</stoploss><leverage>3</leverage></signal>';
  const signal = validateSignalXml(xml, 'default').execution;
  // An isolated Paper fixture enables intent admission; no engine or exchange adapter is running.
  await database.run('UPDATE trading_runtime_state SET execution_enabled=1,kill_switch_active=0');
  for (let index = 0; index < 505; index += 1) {
    const sourceSignalId = `ui-signal-${index}`;
    await saveSignal(sourceSignalId, 'ui-test', index + 1, xml, xml);
    await createTradingIntent({ sourceSignalId, channelId: 'ui-test', signal });
  }
  const commonTime = Date.now() - 1000;
  await database.run('UPDATE trading_trade_intents SET created_at = ?', [commonTime]);
  const cockpit = await uiCockpit();
  assert.equal(cockpit.intents.length, 50);
  assert.equal(cockpit.coverage.intents, true);
  assert.equal(cockpit.overview.pendingIntentCount, 505);
  assert.ok(cockpit.intents.every(intent => !('plan' in intent)));
  assert.ok(cockpit.accounts.every(account => !('externalAccountId' in account) && !('capabilities' in account)));
  assert.ok(!('strategies' in cockpit) && !('channelRiskEvaluations' in cockpit));
  const filters = { channelId: 'ui-test', limit: 100 };
  const first = await listTradeJournalPage(filters);
  assert.equal(first.entries.length, 100);
  assert.equal(first.hasMore, true);
  const seen = first.entries.map(entry => entry.intentId);
  let cursor = first.nextCursor;
  while (cursor) {
    const page = await listTradeJournalPage(filters, cursor);
    assert.equal(page.observedAt, first.observedAt);
    seen.push(...page.entries.map(entry => entry.intentId));
    cursor = page.nextCursor;
  }
  assert.equal(seen.length, 505, 'The list must traverse beyond the old 500-row limit.');
  assert.equal(new Set(seen).size, 505, 'Equal timestamps must not produce omissions or duplicates.');
  assert.deepEqual(seen, [...seen].sort().reverse(), 'IDs are the stable descending tie breaker.');
  await assert.rejects(listTradeJournalPage({ ...filters, reviewed: true }, first.nextCursor), /match/);
  await assert.rejects(listTradeJournalPage(filters, `${first.nextCursor}x`), /cursor/);
  await assert.rejects(listTradeJournalPage({ status: 'open' }), /status/);
  const intentId = seen[0];
  const account = await uiAccountDetail('paper-default');
  assert.equal(account.account.mode, 'paper');
  const originalAccount = await getTradingAccount('paper-default');
  await updateTradingAccountConfiguration('paper-default', { maxConcurrentPositions: 18, baseUpdatedAt: originalAccount.updatedAt });
  await assert.rejects(updateTradingAccountConfiguration('paper-default', { maxConcurrentPositions: 19, baseUpdatedAt: originalAccount.updatedAt }), /configuration changed/);
  assert.equal((await getTradingAccount('paper-default')).maxConcurrentPositions, 18);
  assert.equal(account.account.externalAccountId, undefined);
  assert.equal(account.protection.every(item => !item.protected), true, 'Absence of current receipt is never healthy.');
  assert.equal((await uiTradeSafety(intentId, 'paper-default')).ownership, null, 'No order and fill history must not be presented as proved zero.');
  assert.equal(await uiAccountDetail('absent'), null);
  for (const kind of ['positions', 'orders', 'operations', 'incidents', 'reconciliations']) {
    const page = await uiTradingPage(kind, new URLSearchParams({ accountId: 'paper-default', limit: '1' }));
    assert.equal(page.hasMore, false);
    assert.equal(page.entries.length, 0);
    await assert.rejects(uiTradingPage(kind, new URLSearchParams({ limit: '101' })), /Invalid/);
  }
  await assert.rejects(uiTradingPage('raw_database', new URLSearchParams()), /Unsupported/);
  const before = await database.get('SELECT * FROM trading_trade_intents WHERE id = ?', [intentId]);
  const review = await updateTradeJournalReview({ intentId, notes: '', tags: [], rating: null, reviewed: false, baseReviewUpdatedAt: null });
  assert.equal(review.review.rating, null);
  assert.equal(review.review.reviewed, false);
  await assert.rejects(updateTradeJournalReview({ intentId, notes: 'stale', tags: [], rating: 1, reviewed: true, baseReviewUpdatedAt: null }), /changed/);
  assert.deepEqual(await database.get('SELECT * FROM trading_trade_intents WHERE id = ?', [intentId]), before, 'Review must not mutate execution or original provenance.');
  await updateTradeJournalReview({ intentId, notes: '=SUM(A1)', tags: ['review'], rating: 5, reviewed: true, baseReviewUpdatedAt: review.review.updatedAt });
  assert.equal((await listTradeJournalPage({ reviewed: true })).entries.length, 1);

  for (let index = 0; index < 105; index++) {
    const key = `relation-${String(index).padStart(3, '0')}`;
    await database.run(`INSERT INTO trading_orders (id,intent_id,account_id,client_order_id,role,side,order_type,status,price,quantity,filled_quantity,reduce_only,request_json,created_at,updated_at) VALUES (?,?, 'paper-default',?,'entry','buy','limit','filled','60000.00000001','0.001','0.001',0,?,1000,1000)`, [key, intentId, key, JSON.stringify({ secret: 'PRIVATE_RELATION_PAYLOAD' })]);
    await database.run(`INSERT INTO trading_fills (id,order_id,account_id,exchange_fill_id,price,quantity,fee,fee_asset,filled_at,raw_json) VALUES (?,?,'paper-default',?,'60000.00000001','0.001','0.0000000001','USDT',1000,?)`, [key, key, key, JSON.stringify({ secret: 'PRIVATE_RELATION_PAYLOAD' })]);
    await recordMoneyEvent({ accountId: 'paper-default', accountFingerprint: 'paper:paper-default', providerEventId: key, kind: 'funding', source: 'bounded-ui-fixture', basis: 'provider', occurredAt: 1000, amount: '0.0000000001', asset: 'USDT', intentId });
  }
  for (const kind of ['orders', 'fills', 'money']) {
    const firstRelated = await uiTradeRelationPage(intentId, kind, new URLSearchParams({ limit: '100' }));
    const restRelated = await uiTradeRelationPage(intentId, kind, new URLSearchParams({ limit: '100', cursor: firstRelated.nextCursor }));
    assert.equal(firstRelated.entries.length, 100); assert.equal(firstRelated.hasMore, true); assert.equal(restRelated.entries.length, 5);
    assert.equal(new Set([...firstRelated.entries, ...restRelated.entries].map(row => row.id)).size, 105);
    assert.equal(firstRelated.observedAt, restRelated.observedAt);
    assert.doesNotMatch(JSON.stringify(firstRelated), /PRIVATE_RELATION_PAYLOAD|accountFingerprint/);
    await assert.rejects(uiTradeRelationPage(seen[1], kind, new URLSearchParams({ limit: '100', cursor: firstRelated.nextCursor })), /match/);
  }
  assert.equal((await uiTradeRelationPage(intentId, 'fills', new URLSearchParams())).entries[0].price, '60000.00000001');
  assert.equal((await uiTradeRelationPage(intentId, 'money', new URLSearchParams())).entries[0].amount, '0.0000000001');
  assert.equal((await uiTradeRelationPage(intentId, 'events', new URLSearchParams())).hasMore, false);
  assert.equal(await uiTradeRelationPage('absent', 'orders', new URLSearchParams()), null);
  await assert.rejects(uiTradeRelationPage(intentId, 'constructor', new URLSearchParams()), /Unsupported/);
  const fullJournal = (await listTradeJournalPage({ intentId })).entries[0];
  assert.equal(uiJournalDetail(fullJournal).relationCounts.orders, 105); assert.deepEqual(uiJournalDetail(fullJournal).orders, []);
  assert.equal(uiJournalSummary(fullJournal).plan, undefined); assert.equal(uiJournalSummary(fullJournal).review.notes, undefined);

  const now = Date.now();
  await database.run(`INSERT INTO incoming_work (id, chat_id, message_id, status, reason, created_at, updated_at) VALUES ('work-1', 'ui-test', 1, 'needs_review', 'unproved', ?, ?)`, [now, now]);
  await database.run(`INSERT INTO pending_tasks (id, type, chat_id, message_id, added_at, status, config_json, result_json) VALUES ('task-1', 'single', 'ui-test', 1, ?, 'unknown', ?, ?)`, [now, JSON.stringify({ durableIngress: { targetChatId: '-10001' }, secret: 'MUST_NOT_LEAVE_SERVER' }), JSON.stringify({ acknowledged: true, raw: 'PRIVATE_RESPONSE' })]);
  const outbox = await uiSignalPage('outbox', new URLSearchParams({ status: 'unknown' }));
  assert.equal((await uiSignalPage('processed', new URLSearchParams({ objectId: 'ui-signal-500' }))).entries.length, 1, 'An object link must scope the complete server list.');
  assert.equal((await uiSignalPage('processed', new URLSearchParams({ objectId: 'absent' }))).entries.length, 0);
  assert.equal(outbox.entries[0].targetChatId, '-10001');
  assert.equal(outbox.entries[0].resultMode, 'operator-acknowledged');
  assert.equal(outbox.entries[0].confirmedMessageIds, null, 'Acknowledgment is not a Telegram delivery receipt.');
  assert.doesNotMatch(JSON.stringify(outbox), /MUST_NOT_LEAVE_SERVER|PRIVATE_RESPONSE|config_json/);
  assert.equal((await uiSignalPage('ingress', new URLSearchParams({ status: 'needs_review' }))).entries.length, 1);
  assert.deepEqual((await uiSignalPage('ingress', new URLSearchParams({ channelId: 'ui-test', messageId: '1' }))).entries.map(row => row.id), ['work-1']);
  assert.equal((await uiSignalPage('ingress', new URLSearchParams({ channelId: 'ui-test', messageId: '2' }))).entries.length, 0);
  await assert.rejects(() => uiSignalPage('ingress', new URLSearchParams({ messageId: '1e5' })), /message ID/);
  assert.equal((await uiIngressDetail('work-1')).work.status, 'needs_review');
  await testIngressRelations(database);
  assert.equal(await uiIngressDetail('missing'), null);
  await assert.rejects(uiSignalPage('ingress', new URLSearchParams({ status: 'open' })), /Invalid/);
  const graph = { schemaVersion: 3, nodes: [], edges: [] };
  const activeBeforeDraft = await getActiveWorkflow();
  const draft = await saveUiWorkflowDraft({ id: 'operator', baseVersion: null, baseRevisionId: activeBeforeDraft?.id ?? null, graph }, 'test:admin');
  assert.equal(draft.version, 1);
  await assert.rejects(saveUiWorkflowDraft({ id: 'operator', baseVersion: null, baseRevisionId: null, graph }, 'test:admin'), /VERSION_CONFLICT/);
  assert.deepEqual(await getActiveWorkflow(), activeBeforeDraft, 'Graph drafts do not activate workflows.');
  const resource = await createWorkflowResourceDraft({ kind: 'channel', name: 'Draft channel', configuration: { channelId: 'ui-test' } });
  const edited = await updateWorkflowResourceDraft(resource.id, { name: 'Edited channel', configuration: resource.configuration, baseEditRevision: 0 });
  assert.equal(edited.editRevision, 1);
  await assert.rejects(updateWorkflowResourceDraft(resource.id, { name: 'Stale', configuration: resource.configuration, baseEditRevision: 0 }), /changed/);
  await assert.rejects(publishWorkflowResource(resource.id, Date.now(), 0), /changed/);
  assert.equal((await publishWorkflowResource(resource.id, Date.now(), 1)).status, 'published');
  assert.deepEqual(await getActiveWorkflow(), activeBeforeDraft, 'Resource publication does not activate a graph.');
  await closeDb(); await initDb(path.join(directory, 'test.db'));
  assert.equal((await getUiWorkflowDraft('operator')).version, 1, 'Graph drafts survive reopening the database.');
  await assert.rejects(deleteUiWorkflowDraft('operator', 2), /VERSION_CONFLICT/);
  assert.equal((await deleteUiWorkflowDraft('operator', 1)).deleted, true);
  await testAccountEvidence(getDatabase());
  console.log('UI Next pagination, CAS, original risk reservations and read-only history evidence passed.');
} finally {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}
