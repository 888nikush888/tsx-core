// Isolated review probes only. No real account, adapter, network, runtime or existing database is used.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb, getDatabase, saveSignal } from '../src/db.js';
import { getTradingAccount, listTradingStrategies } from '../src/trading_repository.js';
import { prepareTradingOperation, resolveObservedOperations, transitionTradingOperation } from '../src/trading_recovery.js';
import { persistTradingOrderResult } from '../src/trading_order_repository.js';
import { provenFillIdentity } from '../src/trading_fill_identity.js';
import { persistCorrelatedFill } from '../src/trading_evidence_repository.js';
import { recordFeeEvent } from '../src/trading_money_ledger.js';
import { seedTradingFixtures } from '../tests/trading_fixtures.js';
import { nativeFillFixture } from '../tests/fixtures/native_fill_identity.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'legacy-fill-review-'));
const fingerprint = 'a'.repeat(64), credential = 'b'.repeat(64);
const originalColumns = 'id,order_id,account_id,exchange_fill_id,price,quantity,fee,fee_asset,filled_at,raw_json,account_fingerprint,accounting_json,accounting_conflict';
const hash = value => createHash('sha256').update(value).digest('hex');

async function fixture(name, nativeOriginal) {
  await initDb(path.join(directory, `${name}.db`));
  await seedTradingFixtures();
  const database = getDatabase(), [strategy] = await listTradingStrategies();
  await database.run(`INSERT INTO trading_accounts(id,name,exchange,mode,status,enabled,credential_ref,external_account_id,
    credential_generation,created_at,updated_at) VALUES('review','Isolated review','bybit','testnet','ready',1,'fixture-only',?,?,1,1)`,
  [fingerprint, credential]);
  const account = await getTradingAccount('review');
  await saveSignal(name, name, 1, '<signal/>', '<signal/>');
  await database.run(`INSERT INTO trading_trade_intents(id,source_signal_id,root_source_signal_id,channel_id,strategy_version_id,
    account_id,exchange,mode,symbol,side,status,signal_json,created_at,updated_at)
    VALUES('intent',?,?,?,?,'review','bybit','testnet','BTCUSDT','LONG','monitoring','{}',1,1)`, [name, name, name, strategy.id]);
  const request = { accountId: account.id, clientOrderId: 'client-original', symbol: 'BTCUSDT', role: 'entry', side: 'buy',
    orderType: 'limit', price: '100', quantity: '1', triggerPrice: null, reduceOnly: false, postOnly: false,
    targetIndex: null, leverage: 1, timeoutSeconds: 10 };
  await database.run(`INSERT INTO trading_orders(id,intent_id,account_id,client_order_id,role,side,order_type,status,
    price,quantity,filled_quantity,reduce_only,request_json,created_at,updated_at)
    VALUES('order','intent','review',?,'entry','buy','limit','submitting','100','1','0',0,?,1,1)`,
  [request.clientOrderId, JSON.stringify(request)]);
  const operationId = await prepareTradingOperation({ account, intentId: 'intent', kind: 'submit', clientOrderIds: [request.clientOrderId], request });
  await transitionTradingOperation(operationId, 'prepared', 'dispatching');
  const ack = { clientOrderId: request.clientOrderId, exchangeOrderId: 'remote-original', providerSymbol: 'BTC/USDT:USDT',
    status: 'filled', filledQuantity: '1', averagePrice: '100', error: null,
    raw: { id: 'remote-original', clientOrderId: request.clientOrderId, symbol: 'BTC/USDT:USDT',
      info: { orderId: 'remote-original', orderLinkId: request.clientOrderId, symbol: 'BTCUSDT' } } };
  await persistTradingOrderResult('intent', request.clientOrderId, ack);
  await resolveObservedOperations(account, [{ ...ack, symbol: 'BTCUSDT', role: 'entry', side: 'buy', quantity: '1',
    price: '100', triggerPrice: null, reduceOnly: false }]);
  const incoming = nativeFillFixture('bybit', { exchangeFillId: 'execution-original', exchangeOrderId: ack.exchangeOrderId,
    clientOrderId: request.clientOrderId, symbol: 'BTCUSDT', providerSymbol: ack.providerSymbol,
    price: '100', quantity: '1', fee: '0.1', feeAsset: 'USDT', filledAt: 123, raw: {} });
  incoming.accounting = { version: 1, source: 'ccxt-market-v1', providerSymbol: ack.providerSymbol,
    settlementAsset: 'USDT', linear: true, quantityUnit: 'base' };
  const originalRaw = structuredClone(incoming.raw);
  if (!nativeOriginal) originalRaw.info = {};
  // Exactly the original columns that survive M39→40; no M40 identity is preinstalled.
  await database.run(`INSERT INTO trading_fills(${originalColumns}) VALUES('old-local-fill','order','review',?,'100','1','0.1','USDT',123,?,?,?,0)`,
  [incoming.exchangeFillId, JSON.stringify(originalRaw), fingerprint, JSON.stringify(incoming.accounting)]);
  const fee = { accountId: account.id, accountFingerprint: fingerprint, providerEventId: incoming.exchangeFillId,
    source: 'bybit:own-fill-v1', basis: 'fill', occurredAt: 123, fee: '0.1', asset: 'USDT', intentId: 'intent', fillId: 'old-local-fill' };
  await recordFeeEvent(fee);
  return { account, incoming, operationId, originalRaw, fee };
}

async function probe(name, nativeOriginal) {
  const value = await fixture(name, nativeOriginal), database = getDatabase();
  const original = await database.get(`SELECT ${originalColumns} FROM trading_fills WHERE id='old-local-fill'`);
  const money = await database.all('SELECT * FROM trading_money_events ORDER BY id');
  const operation = await database.get('SELECT * FROM trading_operations WHERE id=?', [value.operationId]);
  assert.equal(operation.phase, 'resolved');
  assert.equal(hash(operation.request_json), operation.request_hash);
  assert.equal(operation.account_fingerprint, original.account_fingerprint);
  assert.equal(operation.credential_generation, credential);
  assert.equal(JSON.parse(operation.evidence_json).orders[0].exchangeOrderId, value.incoming.exchangeOrderId);
  assert.equal((await database.get('SELECT COUNT(*) AS n FROM trading_order_identity_bindings')).n, 0,
    'A table introduced by M40 cannot be demanded as an original M39 witness.');
  const oldNative = provenFillIdentity(value.account, { ...value.incoming, raw: value.originalRaw });
  assert.equal(Boolean(oldNative), nativeOriginal, 'Only the positive case already has exact native originals in its old raw record.');
  assert.match(value.originalRaw.symbol, /^[A-Z0-9]+\/[A-Z0-9]+:[A-Z0-9]+$/,
    'This narrow positive fixture has the original full suffix-free CCXT symbol, not an option or canonical symbol.');
  assert.equal(JSON.parse(original.accounting_json).settlementAsset, value.originalRaw.symbol.split(':')[1]);
  const result = await persistCorrelatedFill(value.account, value.incoming);
  assert.equal((await database.get('SELECT COUNT(*) AS n FROM trading_fills')).n, 1, 'Do not insert a second booked fill.');
  assert.deepEqual(await database.get(`SELECT ${originalColumns} FROM trading_fills WHERE id='old-local-fill'`), original,
    'Original ID, raw bytes and all original economics remain unchanged.');
  await recordFeeEvent({ ...value.fee, source: 'another-fixture-transport', providerEventId: 'alternate-label' });
  assert.deepEqual(await database.all('SELECT * FROM trading_money_events ORDER BY id'), money, 'Identity enrichment never rewrites or duplicates money originals.');
  const stored = await database.get("SELECT identity_status,remote_fill_key FROM trading_fills WHERE id='old-local-fill'");
  if (!nativeOriginal) assert.equal(stored.identity_status, 'legacy_unresolved', 'A new incoming original cannot replace a missing old native identity.');
  if (stored.identity_status === 'proven') assert.equal(result.fillId, 'old-local-fill');
  console.log(JSON.stringify({ case: name, oldNativeProof: Boolean(oldNative), oldJournalPhase: operation.phase,
    resultFillId: result.fillId ?? null, identityStatus: stored.identity_status, fillRows: 1, moneyRows: money.length }));
  await closeDb();
}

try {
  await probe('complete-originals', true);
  await probe('same-economics-missing-native-original', false);
} finally { await closeDb(); await rm(directory, { recursive: true, force: true }); }
