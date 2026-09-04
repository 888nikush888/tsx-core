import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb } from '../src/db.js';
import { listTradingAccounts } from '../src/trading_repository.js';
import { historyCheckpoints } from '../src/trading_history_repository.js';
import { recordAcquisitionEvidence } from '../src/trading_evidence_repository.js';
import { assertHistoryResponse, validateHistoryProgress } from '../src/exchange_history_contract.js';
import { seedTradingFixtures } from './trading_fixtures.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'exchange-history-'));
const databasePath = path.join(directory, 'test.db');
const since = Date.now() - 45 * 86_400_000;
function progress(checkpoint, pages = 1) {
  return { baseRevision: checkpoint.revision, pages, checkpoint: { ...checkpoint, revision: checkpoint.revision + 1,
    windowUntil: checkpoint.windowSince + 7 * 86_400_000, cursor: 'next-page', completeness: 'partial', reason: 'history_pending' } };
}
function evidence(history) {
  const now = Date.now();
  return { version: 1, startedAt: now, completedAt: now, checkedOrders: [], history,
    sources: ['positions', 'orders', 'fills', 'targeted_orders'].map(source => ({ source, startedAt: now, completedAt: now,
      completeness: 'unknown', reason: 'history_pending', since })) };
}
try {
  const through = since + 7 * 86_400_000;
  const covered = { source: 'fills', providerSymbol: null, revision: 1, baselineSince: since,
    windowSince: through - 1000, windowUntil: null, cursor: null, scannedThrough: through, nextReadAt: 0,
    completeness: 'partial', reason: 'history_pending', coverage: {
      version: 1, profile: 'kraken_v3_executions_v1', since, through } };
  for (const patch of [{ profile: 'made_up' }, { since: since + 1 }, { through: through + 1 }, { version: 2 }]) {
    assert.throws(() => validateHistoryProgress([{ baseRevision: 0, pages: 1,
      checkpoint: { ...covered, coverage: { ...covered.coverage, ...patch } } }]), /coverage/);
  }
  assert.deepEqual(validateHistoryProgress([{ baseRevision: 0, pages: 1, checkpoint: covered }])[0].checkpoint.coverage,
    covered.coverage, 'The exact proven interval must survive the Node boundary.');
  await initDb(databasePath);
  await seedTradingFixtures();
  const [fixtureAccount] = await listTradingAccounts();
  const account = { ...fixtureAccount, externalAccountId: 'a'.repeat(64) };
  const initial = await historyCheckpoints(account, since);
  assert.equal(initial.length, 2);
  assert.ok(initial.every(row => row.revision === 0 && row.baselineSince === since && row.scannedThrough === null));
  assert.ok(initial.every(row => row.retention === null), 'A new obligation must not inherit a retention probe.');
  const first = initial.map(checkpoint => progress(checkpoint));
  for (const item of first) item.checkpoint.providerAccountUid = 'fixture-provider-account';
  assertHistoryResponse(initial, validateHistoryProgress(first));
  // Receiving a response alone must never acknowledge history ingestion.
  assert.deepEqual(await historyCheckpoints(account, since), initial);
  const currentEvidence = evidence(first);
  currentEvidence.sources[0].scopes = [{ scope: 'linear:USDT', pages: 2, complete: true, headers: 'MUST_NOT_PERSIST' }];
  await recordAcquisitionEvidence(account, currentEvidence);
  await closeDb();
  await initDb(databasePath);
  const storedEvidence = await getDatabase().get('SELECT payload_json FROM trading_acquisition_evidence');
  assert.deepEqual(JSON.parse(storedEvidence.payload_json).sources[0].scopes, [{ scope: 'linear:USDT', pages: 2, complete: true }]);
  assert.doesNotMatch(storedEvidence.payload_json, /MUST_NOT_PERSIST|headers/);
  const resumed = await historyCheckpoints(account, since);
  assert.ok(resumed.every(row => row.cursor === 'next-page' && row.revision === 1 && row.baselineSince === since));
  assert.ok(resumed.every(row => row.providerAccountUid === 'fixture-provider-account'));
  assert.ok(resumed.every(row => row.windowUntil === since + 7 * 86_400_000), 'Restart must retain the fixed provider window.');
  const foreignBinding = await historyCheckpoints({ ...account, externalAccountId: 'b'.repeat(64) }, since);
  assert.ok(foreignBinding.every(row => row.revision === 0 && row.cursor === null), 'Another verified identity must not inherit traversal progress.');
  await assert.rejects(recordAcquisitionEvidence(account, evidence(first)), /checkpoint/);
  assert.deepEqual(await historyCheckpoints(account, since), resumed, 'A replayed response cannot rewind the durable cursor.');

  const second = resumed.map(checkpoint => progress(checkpoint));
  second[1].baseRevision = 0;
  second[1].checkpoint.revision = 1;
  const countBefore = await getDatabase().get('SELECT COUNT(*) AS count FROM trading_acquisition_evidence');
  await assert.rejects(recordAcquisitionEvidence(account, evidence(second)), /checkpoint/);
  assert.deepEqual(await historyCheckpoints(account, since), resumed, 'A late CAS conflict rolls back all checkpoints in the acquisition.');
  assert.deepEqual(await getDatabase().get('SELECT COUNT(*) AS count FROM trading_acquisition_evidence'), countBefore);

  assert.throws(() => assertHistoryResponse(resumed, []), /omitted/);
  const unread = resumed.map(checkpoint => progress(checkpoint, 0));
  unread[0].checkpoint.cursor = 'skipped-without-reading';
  assert.throws(() => assertHistoryResponse(resumed, unread), /unread page/);
  assert.throws(() => validateHistoryProgress(resumed.map(checkpoint => progress(checkpoint, 3))), /budget/);
  assert.throws(() => validateHistoryProgress([first[0], first[0]]), /duplicate/);
  const changedProvider = resumed.map(checkpoint => progress(checkpoint));
  changedProvider[0].checkpoint.providerAccountUid = 'another-provider-account';
  assert.throws(() => validateHistoryProgress(changedProvider), /provider account identity/);
  for (const item of changedProvider) item.checkpoint.providerAccountUid = 'another-provider-account';
  assert.throws(() => assertHistoryResponse(resumed, validateHistoryProgress(changedProvider)), /provider account identity changed/);
  assert.throws(() => validateHistoryProgress([{ ...first[0], checkpoint: { ...first[0].checkpoint, windowUntil: null } }]), /window/);
  const sanitized = validateHistoryProgress([{ ...first[0], credentials: 'DO_NOT_KEEP', checkpoint: { ...first[0].checkpoint, authorization: 'DO_NOT_KEEP' } }]);
  assert.ok(!JSON.stringify(sanitized).includes('DO_NOT_KEEP'));
  const deferred = resumed.map(checkpoint => ({ baseRevision: checkpoint.revision, pages: 0,
    checkpoint: { ...checkpoint, revision: checkpoint.revision + 1, nextReadAt: Date.now() + 90_000, reason: 'history_transient' } }));
  await recordAcquisitionEvidence(account, evidence(deferred));
  await closeDb();
  await initDb(databasePath);
  const afterCooldown = await historyCheckpoints(account, since);
  assert.ok(afterCooldown.every(row => row.nextReadAt > Date.now() && row.cursor === 'next-page'));
  const older = since - 10 * 86_400_000;
  const rewound = await historyCheckpoints(account, older);
  assert.ok(rewound.every(row => row.baselineSince === older && row.windowSince === older && row.cursor === null && row.scannedThrough === null));
  assert.ok(rewound.every(row => row.revision === 3 && row.completeness === 'unknown'));
  await assert.rejects(recordAcquisitionEvidence(account, evidence(afterCooldown.map(checkpoint => progress(checkpoint)))), /checkpoint/);
  assert.deepEqual(await historyCheckpoints(account, since), rewound, 'Later query windows cannot erase an older unresolved obligation.');
  const fillCheckpoint = rewound.find(row => row.source === 'fills');
  const end = older + 7 * 86_400_000;
  const coveredUpdate = { baseRevision: fillCheckpoint.revision, pages: 1, checkpoint: { ...fillCheckpoint,
    revision: fillCheckpoint.revision + 1, windowSince: end - 1000, scannedThrough: end,
    coverage: { version: 1, profile: 'kraken_v3_executions_v1', since: older, through: end } } };
  await recordAcquisitionEvidence(account, evidence([coveredUpdate]));
  await closeDb();
  await initDb(databasePath);
  const proved = (await historyCheckpoints(account, older)).find(row => row.source === 'fills');
  assert.deepEqual(proved.coverage, coveredUpdate.checkpoint.coverage);
  const regression = { baseRevision: proved.revision, pages: 0, checkpoint: { ...proved, revision: proved.revision + 1, coverage: null } };
  await assert.rejects(recordAcquisitionEvidence(account, evidence([regression])), /coverage/);
  assert.deepEqual((await historyCheckpoints(account, older)).find(row => row.source === 'fills'), proved);
  const earlierScope = await historyCheckpoints(account, older - 1);
  assert.equal(earlierScope.find(row => row.source === 'fills').coverage, null, 'Expanded obligations invalidate old coverage explicitly.');
  // Simulate a retained pre-coverage checkpoint: do not promote its traversal watermark.
  const legacy = { ...proved, retention: { version: 1, phase: 'proved', originalSince: older, originalUntil: end,
    startedAt: end, fixedUntil: end, cursor: end, count: 1, validatedAt: end,
    anchor: { coin: 'BTC', tid: 'fixture-old-anchor', time: older, payloadHash: 'a'.repeat(64) } } };
  delete legacy.coverage;
  await getDatabase().run("UPDATE trading_history_checkpoints SET revision = ?, checkpoint_json = ? WHERE account_id = ? AND account_fingerprint = ? AND source = 'fills'",
    [legacy.revision, JSON.stringify(legacy), account.id, account.externalAccountId]);
  const legacyReset = (await historyCheckpoints(account, older)).find(row => row.source === 'fills');
  assert.equal(legacyReset.windowSince, older);
  assert.equal(legacyReset.scannedThrough, null);
  assert.equal(legacyReset.coverage, null);
  assert.equal(legacyReset.retention, null, 'A legacy coverage reset also discards the old retention anchor and count.');
  assert.equal(legacyReset.reason, 'legacy_coverage_unproved');
  const sameLegacyReset = (await historyCheckpoints(account, older)).find(row => row.source === 'fills');
  assert.deepEqual(sameLegacyReset, legacyReset, 'Legacy repair is one-time and preserves its original obligation boundary.');
  console.log('Durable history checkpoints: restart, scope, CAS, rollback, redaction and cooldown passed.');
} finally {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}
