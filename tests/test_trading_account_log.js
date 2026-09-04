import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb } from '../src/db.js';
import { getTradingAccount } from '../src/trading_repository.js';
import { accountLogDigest, validateAccountLogProgress, assertAccountLogResponse } from '../src/trading_account_log_contract.js';
import { bindAccountReportingCurrency, moneyLedgerSnapshot, recordMoneyEvent } from '../src/trading_money_ledger.js';
import { seedPostUta2Origin } from './fixtures/account_log.js';
const logs = await import('../src/trading_account_log_repository.js');
const { projectAccountLogMoney } = await import('../src/trading_account_log_money.js');
const { observedFundingEvidence, assertFundingObservationCurrent } = await import('../src/trading_funding_observation.js');
const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-account-log-'));
const filename = path.join(directory, 'test.db');
const now = Date.now();
const since = new Date(now).setUTCHours(0, 0, 0, 0);
function progress(checkpoint, records, cursor = null) {
  const until = checkpoint.windowUntil ?? now;
  const receipt = { version: 1, namespace: checkpoint.namespace, filterHash: checkpoint.filterHash,
    accountFingerprint: checkpoint.accountFingerprint, credentialGeneration: checkpoint.credentialGeneration,
    since: checkpoint.windowSince, until, cursor: checkpoint.cursor, nextCursor: cursor,
    startedAt: now, completedAt: now, providerResponseAt: now, providerAccountUid: null, exhausted: cursor === null, records };
  return { baseRevision: checkpoint.revision, calls: 1, receipts: [receipt], checkpoint: { ...checkpoint,
    revision: checkpoint.revision + 1, cursor, windowUntil: cursor === null ? null : until,
    scannedThrough: cursor === null ? until : checkpoint.scannedThrough, lastServedAt: now } };
}
try {
  await initDb(filename);
  await getDatabase().run(`INSERT INTO trading_accounts (id,name,exchange,mode,status,enabled,credential_ref,external_account_id,
    credential_generation,created_at,updated_at) VALUES ('log','Log','bybit','testnet','ready',1,'fixture',?,?,?,?)`, ['a'.repeat(64), 'b'.repeat(64), since, since]);
  const account = await getTradingAccount('log');
  assert.match((await observedFundingEvidence(account, now)).reason, /source_origin/);
  await seedPostUta2Origin(account, since - 1000);
  await bindAccountReportingCurrency({ accountId: account.id, accountFingerprint: account.externalAccountId, profile: 'bybit',
    reportingCurrency: 'USD', settlementAssets: ['USD'], source: 'bybit-wallet-balance-v1', verifiedAt: now });
  const row = { id: 'legacy', transactionTime: String(now - 1), type: 'SETTLEMENT', funding: '-1.25', currency: 'USD', cashFlow: '0', fee: '0' };
  await recordMoneyEvent({ accountId: account.id, accountFingerprint: account.externalAccountId, providerEventId: row.id,
    kind: 'funding', source: 'bybit:funding-v1', basis: 'provider', occurredAt: now - 1, amount: '-1.25', asset: 'USD' });
  let checkpoint = await logs.accountLogCheckpoint(account);
  const unchanged = await getDatabase().get('SELECT * FROM trading_account_log_checkpoints WHERE account_id=?', [account.id]);
  const skipped = { baseRevision: checkpoint.revision, calls: 0, receipts: [], checkpoint, readSkipped: 'budget_exhausted' };
  assert.deepEqual(validateAccountLogProgress(skipped), skipped);
  assertAccountLogResponse(checkpoint, skipped);
  await logs.persistAccountLogProgress(account, skipped);
  assert.deepEqual(await getDatabase().get('SELECT * FROM trading_account_log_checkpoints WHERE account_id=?', [account.id]), unchanged,
    'A granted but unperformed log read must preserve producer parity and every original checkpoint field.');
  for (const next of [{ ...skipped, readSkipped: 'made_up' }, { ...skipped, calls: 1 },
    { ...skipped, checkpoint: { ...checkpoint, revision: checkpoint.revision + 1 } }]) {
    assert.throws(() => validateAccountLogProgress(next), /account-log/i);
  }
  const edited = { ...skipped, checkpoint: { ...checkpoint, lastServedAt: now } };
  assert.throws(() => assertAccountLogResponse(checkpoint, edited), /account-log/i);
  await assert.rejects(logs.persistAccountLogProgress(account, edited), /account-log/i);
  const first = progress(checkpoint, [row], 'next');
  await logs.persistAccountLogProgress(account, first);
  await closeDb(); await initDb(filename);
  checkpoint = await logs.accountLogCheckpoint(account);
  assert.equal(checkpoint.cursor, 'next');
  assert.equal(checkpoint.revision, 1);
  await projectAccountLogMoney(account);
  assert.equal((await getDatabase().get('SELECT COUNT(*) AS n FROM trading_money_events')).n, 1, 'Legacy funding is not duplicated by its new source namespace.');
  assert.equal((await observedFundingEvidence(account, now)).observation.status, 'incomplete');
  const final = progress(checkpoint, [row]);
  await logs.persistAccountLogProgress(account, final);
  await projectAccountLogMoney(account);
  const proof = (await observedFundingEvidence(account, now)).observation;
  assert.equal(proof.status, 'observed'); assert.equal(proof.amount, '-1.25');
  assert.equal(proof.finality, 'provider_as_observed'); assert.equal(proof.delivery, 'may_be_delayed');
  await assert.rejects(assertFundingObservationCurrent(account, { ...proof, amount: '999' }), /stale|unresolved/i,
    'The actual persisted amount, not just a caller-copied hash, binds the financial proof.');
  await assert.rejects(logs.persistAccountLogProgress(account, first), /revision/i);
  assert.equal((await logs.pendingAccountLogReceipts(account.id, 'scope')).length, 2, '002 has its own durable independent consumer.');
  checkpoint = await logs.accountLogCheckpoint(account);
  await logs.persistAccountLogProgress(account, progress(checkpoint, [{ ...row, id: 'late-loss', funding: '-2' }]));
  await projectAccountLogMoney(account);
  const late = (await observedFundingEvidence(account, now)).observation;
  assert.equal(late.amount, '-3.25'); assert.notEqual(late.revisionHash, proof.revisionHash);
  assert.equal((await moneyLedgerSnapshot(account.id, since, now + 1)).funding, '-3.25');
  checkpoint = await logs.accountLogCheckpoint(account);
  await logs.persistAccountLogProgress(account, progress(checkpoint, [{ ...row, funding: '-9' }]));
  await projectAccountLogMoney(account);
  assert.equal((await observedFundingEvidence(account, now)).observation.status, 'incomplete');
  assert.equal((await getDatabase().get('SELECT COUNT(*) AS n FROM trading_money_conflicts')).n, 1);
  assert.equal((await getDatabase().all('PRAGMA foreign_key_check')).length, 0);
  assert.notEqual(accountLogDigest(proof), accountLogDigest(late));
  console.log('Durable account-log continuation, independent consumers, observed coverage and legacy-safe funding replay passed.');
} finally {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}
