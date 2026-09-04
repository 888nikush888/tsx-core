import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb } from '../src/db.js';
import { getTradingAccount } from '../src/trading_repository.js';
import { accountLogCheckpoint, persistAccountLogProgress } from '../src/trading_account_log_repository.js';
import { bindAccountReportingCurrency, moneyLedgerSnapshot } from '../src/trading_money_ledger.js';
import { observedFundingEvidence } from '../src/trading_funding_observation.js';
import { logProgress } from './fixtures/account_log.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-money-audit-'));
const filename = path.join(directory, 'test.db');
const actualNow = Date.now, day = 86400000;
let now = Date.UTC(2026, 8, 2, 23, 59, 59);
Date.now = () => now;
try {
  await initDb(filename);
  await getDatabase().run(`INSERT INTO trading_accounts (id,name,exchange,mode,status,enabled,credential_ref,external_account_id,
    credential_generation,created_at,updated_at) VALUES ('audit','Audit','hyperliquid','testnet','ready',1,'fake',?,?,?,?)`,
  ['a'.repeat(64), 'b'.repeat(64), now - 20 * day, now]);
  const account = await getTradingAccount('audit');
  await bindAccountReportingCurrency({ accountId: account.id, accountFingerprint: account.externalAccountId, profile: 'hyperliquid',
    reportingCurrency: 'USDC', settlementAssets: ['USDC'], source: 'hyperliquid-clearinghouse-state-v1', verifiedAt: now });
  const seed = await accountLogCheckpoint(account);
  const requiredSince = Math.floor(now / day) * day - 20 * day;
  // Reconstitute a legitimate old producer cursor, not invented monetary events.
  const restored = { ...seed, requiredSince, windowSince: requiredSince, windowUntil: requiredSince + 7 * day };
  await getDatabase().run('UPDATE trading_account_log_checkpoints SET payload_json=? WHERE account_id=?', [JSON.stringify(restored), account.id]);
  for (let index = 0; index < 4; index += 1) {
    const current = await accountLogCheckpoint(account);
    const pinned = { ...current, windowUntil: current.windowUntil ?? Math.min(now, current.windowSince + 7 * day) };
    await persistAccountLogProgress(account, logProgress(pinned, [], now));
  }
  let checkpoint = await accountLogCheckpoint(account);
  assert.equal(checkpoint.scannedThrough, now);
  await persistAccountLogProgress(account, logProgress(checkpoint, [], now));
  checkpoint = await accountLogCheckpoint(account);
  const audit = { windowSince: requiredSince, windowUntil: requiredSince + 7 * day, cursor: null, completedAt: 0 };
  const oldTime = requiredSince + day;
  const row = { type: 'funding', hash: '0x' + '0'.repeat(64), coin: 'BTC', time: String(oldTime), usdc: '-2' };
  const page = logProgress({ ...checkpoint, audit }, [row], now, String(oldTime), 'audit');
  await persistAccountLogProgress(account, page);
  await closeDb(); await initDb(filename);
  checkpoint = await accountLogCheckpoint(account);
  assert.equal(checkpoint.audit.cursor, String(oldTime));
  assert.equal(checkpoint.scannedThrough, now, 'Historical audit cannot mint a newer forward observation.');
  const midnight = Math.floor(now / day) * day + day;
  now = midnight + 1000;
  assert.equal((await observedFundingEvidence(account)).observation.status, 'incomplete', 'UTC change requires a new current-day source scan.');
  await persistAccountLogProgress(account, logProgress(checkpoint, [], now));
  checkpoint = await accountLogCheckpoint(account);
  assert.equal(checkpoint.requiredSince, requiredSince, 'Old obligations are not discarded at midnight.');
  assert.equal(checkpoint.audit.cursor, String(oldTime), 'The old pinned audit page survives the new-day forward scan.');
  await persistAccountLogProgress(account, logProgress(checkpoint, [], now, null, 'audit'));
  assert.equal((await observedFundingEvidence(account)).observation.amount, '0', 'Yesterday/older loss remains on its event day, not rebooked today.');
  assert.equal((await moneyLedgerSnapshot(account.id, 0, now + 1)).funding, '-2');
  const before = await getDatabase().all('SELECT * FROM trading_money_events');
  await closeDb(); await initDb(filename);
  assert.deepEqual(await getDatabase().all('SELECT * FROM trading_money_events'), before);
  assert.equal((await getDatabase().all('PRAGMA foreign_key_check')).length, 0);
  console.log('Durable historical audit cursor, fixed old windows, event-day money and UTC-forward fairness passed.');
} finally { Date.now = actualNow; await closeDb(); await rm(directory, { recursive: true, force: true }); }
