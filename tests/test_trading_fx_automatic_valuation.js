import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb } from '../src/db.js';
import { getTradingAccount } from '../src/trading_repository.js';
import { bindAccountReportingCurrency, getMoneyEvent } from '../src/trading_money_ledger.js';
import { accountLogCheckpoint, persistAccountLogProgress } from '../src/trading_account_log_repository.js';
import { observedFundingEvidence, assertFundingObservationCurrent } from '../src/trading_funding_observation.js';
import { captureFxReceipts } from '../src/trading_fx_repository.js';
import { fxReceipt, FX_CONTEXT } from './fixtures/fx_receipts.js';
import { logProgress, seedPostUta2Origin } from './fixtures/account_log.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-fx-automatic-')), filename = path.join(directory, 'test.db');
const now = Date.now(), today = new Date(now).setUTCHours(0, 0, 0, 0), at = now - 1000;
const realNow = Date.now;
async function fixture(id, profileVersion = 1) {
  await getDatabase().run(`INSERT INTO trading_accounts(id,name,exchange,mode,status,enabled,credential_ref,
    external_account_id,credential_generation,capabilities_json,last_verified_at,created_at,updated_at)
    VALUES (?,?,'bybit','testnet','ready',1,'fixture',?,?,?,?,?,?)`, [id, id, createHash('sha256').update(id).digest('hex'), 'c'.repeat(64),
  JSON.stringify({ profileVersion, executionProfileHash: FX_CONTEXT.profileHash, executionCapabilities: { provider_api_version: 'bybit-v5' } }),
  today - 2000, today - 3000, now]);
  const account = await getTradingAccount(id);
  await bindAccountReportingCurrency({ accountId: id, accountFingerprint: account.externalAccountId, profile: 'bybit', reportingCurrency: 'USD',
    settlementAssets: ['USDT', 'USDC'], source: 'bybit-wallet-balance-v1', verifiedAt: now });
  await seedPostUta2Origin(account, today - 1000);
  return account;
}
async function funding(account, id, currency = 'USDT', transactionTime = at) {
  const checkpoint = await accountLogCheckpoint(account);
  const record = { id, type: 'SETTLEMENT', category: 'linear', transactionTime: String(transactionTime), currency,
    funding: '-10', fee: '0', cashFlow: '0' };
  await persistAccountLogProgress(account, logProgress(checkpoint, [record], now));
  const observed = await observedFundingEvidence(account, now);
  const row = await getDatabase().get('SELECT id FROM trading_money_events WHERE account_id=? AND provider_event_id=?', [account.id, id]);
  return { observed, event: await getMoneyEvent(row.id) };
}
try {
  Date.now = () => now;
  await initDb(filename);
  const account = await fixture('fx-auto');
  const initial = await funding(account, 'first');
  assert.equal(initial.observed.status, 'incomplete');
  assert.equal(initial.event.reportingValue, null);
  assert.ok(await getDatabase().get('SELECT reason FROM trading_fx_valuation_work WHERE event_id=?', [initial.event.id]));
  await captureFxReceipts(account, [fxReceipt('usd', at - 20), fxReceipt('usdt', at)], { startedAt: at - 100, completedAt: at + 100 });
  const recovered = await observedFundingEvidence(account, now);
  assert.equal(recovered.status, 'complete');
  assert.equal(recovered.observation.amount, null);
  assert.deepEqual(recovered.observation.value.exact, { numerator: '-4000', denominator: '401' });
  const count = await getDatabase().get('SELECT COUNT(*) AS n FROM trading_fx_money_valuations');
  await closeDb(); await initDb(filename);
  assert.deepEqual(await observedFundingEvidence(account, now), recovered);
  assert.deepEqual(await getDatabase().get('SELECT COUNT(*) AS n FROM trading_fx_money_valuations'), count);
  const late = await funding(account, 'late-source-event');
  assert.equal(late.observed.status, 'complete', 'Late source delivery can reuse only its eligible event-time originals.');
  assert.deepEqual(late.observed.observation.value.exact, { numerator: '-8000', denominator: '401' });
  await assert.rejects(assertFundingObservationCurrent(account, recovered.observation), /stale|unresolved/);
  const unsupported = await funding(account, 'other-asset', 'BNB');
  assert.equal(unsupported.observed.status, 'incomplete'); assert.equal(unsupported.event.reportingValue, null);
  assert.equal(await getDatabase().get('SELECT event_id FROM trading_fx_valuation_work WHERE event_id=?', [unsupported.event.id]), undefined);
  const old = await funding(account, 'before-retained-quotes', 'USDT', at - 20_000);
  assert.equal(old.event.reportingValue, null, 'A current quote never fabricates historical valuation.');
  const unreviewed = await fixture('unreviewed', 0);
  const unreviewedResult = await funding(unreviewed, 'unreviewed-event');
  assert.equal(unreviewedResult.observed.status, 'incomplete');
  assert.equal(await getDatabase().get('SELECT event_id FROM trading_fx_valuation_work WHERE account_id=?', [unreviewed.id]), undefined);
  assert.equal((await getDatabase().get('SELECT COUNT(*) AS n FROM trading_fx_receipts')).n, 2, 'The observation hook does not fetch additional quotes.');
  console.log('Bounded automatic local FX replay, restart, late evidence, missing history and unsupported assets/profiles passed.');
} finally {
  Date.now = realNow; await closeDb(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); await rm(directory, { recursive: true, force: true });
}
