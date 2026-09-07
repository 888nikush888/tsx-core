import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb, getDatabase } from '../src/db.js';
import { seedTradingFixtures } from './trading_fixtures.js';
import { getTradingAccount, listTradingStrategies, createTradingStrategyDraft, publishTradingStrategyVersion, archiveTradingStrategyVersion, getTradingStrategyVersion } from '../src/trading_repository.js';
import { createWorkflowResourceDraft, getWorkflowResourceById } from '../src/workflow_repository.js';
import { uiAccountEvidence, uiAccountReservations, uiAccountHistory } from '../src/ui_account_evidence.js';
import { prepareUiParserTest, runUiParserTest } from '../src/ui_parser_lab.js';
import { publishUiResourceWithDependency, uiResourcePublication } from '../src/ui_resource_publication.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-ui-evidence-failures-'));
if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(directory).startsWith('tsx-ui-evidence-failures-')) throw new Error('Unsafe fixture directory.');

async function observationFailures(database) {
  const account = await getTradingAccount('paper-default');
  const now = Date.now(); const day = new Date(now).setUTCHours(0, 0, 0, 0); const id = 'a'.repeat(64);
  assert.equal((await uiAccountEvidence(account.id)).risk, null, 'Missing evidence is never fabricated as a current observation.');
  await database.run(`INSERT INTO trading_risk_observations (id,account_id,account_fingerprint,credential_generation,entry_epoch,observed_at,expires_at,utc_day,evidence_json,recorded_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`, [id, account.id, 'paper:paper-default', account.credentialGeneration, 'fixture-epoch', now - 1000, now + 60000, day, '{"reservations":[]}', now]);
  await database.run('INSERT INTO trading_risk_current(account_id,observation_id) VALUES (?,?)', [account.id, id]);
  const current = (await uiAccountEvidence(account.id)).risk;
  assert.equal(current.timestampFresh, true); assert.equal(current.identityMatches, true); assert.equal(current.credentialGenerationMatches, true);
  assert.equal(current.isCurrentObservation, true); assert.match(current.scope, /not an entry authorization/);
  const nextObservation = async (marker, observedAt, expiresAt, utcDay, fingerprint = 'paper:paper-default', generation = account.credentialGeneration) => {
    const nextId = marker.repeat(64);
    await database.run(`INSERT INTO trading_risk_observations (id,account_id,account_fingerprint,credential_generation,entry_epoch,observed_at,expires_at,utc_day,evidence_json,recorded_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, [nextId, account.id, fingerprint, generation, 'fixture-epoch', observedAt, expiresAt, utcDay, '{"reservations":[]}', now]);
    await database.run('UPDATE trading_risk_current SET observation_id=? WHERE account_id=?', [nextId, account.id]);
  };
  await nextObservation('b', now + 60000, now + 120000, day);
  assert.equal((await uiAccountEvidence(account.id)).risk.timestampFresh, false, 'Future observations cannot appear fresh.');
  await nextObservation('c', now - 1000, now + 60000, day - 86400000);
  assert.equal((await uiAccountEvidence(account.id)).risk.timestampFresh, false, 'An old UTC day invalidates otherwise fresh timestamps.');
  await nextObservation('d', now - 1000, now - 1, day, 'private-other-account', 'private-old-generation');
  const stale = (await uiAccountEvidence(account.id)).risk;
  assert.equal(stale.timestampFresh, false); assert.equal(stale.identityMatches, false); assert.equal(stale.credentialGenerationMatches, false);
  assert.doesNotMatch(JSON.stringify(stale), /private-other-account|private-old-generation|fixture-epoch/);
  assert.equal(await uiAccountReservations(account.id, new URLSearchParams({ observationId: 'f'.repeat(64) })), null);
  await assert.rejects(uiAccountReservations(account.id, new URLSearchParams({ limit: '51' })), /page size/);
  await assert.rejects(uiAccountHistory(account.id, new URLSearchParams({ limit: '-1' })), /page size/);
  assert.equal(await uiAccountHistory('missing-account', new URLSearchParams()), null);
  await database.exec('ALTER TABLE trading_risk_observations RENAME TO unavailable_risk_observations');
  try {
    const partial = await uiAccountEvidence(account.id);
    assert.equal(partial.risk, null); assert.ok(partial.daily); assert.equal(typeof partial.requiredHistorySince, 'number');
    assert.deepEqual(partial.errors.map(error => error.source), ['risk'], 'One failed database source must remain visible while independent evidence survives.');
  } finally { await database.exec('ALTER TABLE unavailable_risk_observations RENAME TO trading_risk_observations'); }
}

async function parserFailures() {
  const sourceText = 'LONG BTCUSDT entry 60000 targets 62000 stoploss 59000 leverage 3';
  for (const pathId of ['../secrets', 'x'.repeat(65), 1, null]) {
    await assert.rejects(prepareUiParserTest({}, { pathId, sourceText }), /path identifier/);
  }
  for (const text of [undefined, '', '   ', 1, 'x'.repeat(101)]) {
    await assert.rejects(prepareUiParserTest({ xmlParsing: { aiLimits: { maxInputChars: 100 } } }, { sourceText: text }), /Source text/);
  }
  for (const aiLimits of [{ requestTimeoutMs: 999 }, { primaryAttempts: 0 }, { dailyTokenLimit: 1.5 }, { maxInputChars: 100001 }]) {
    await assert.rejects(prepareUiParserTest({ xmlParsing: { aiLimits } }, { sourceText }), /Invalid configured AI limit/);
  }
  await assert.rejects(prepareUiParserTest({}, { sourceText, pathId: 'removed-path' }), /not part of the active revision/);
  const prepared = await prepareUiParserTest({}, { sourceText });
  let calls = 0; const provider = async () => { calls++; throw new Error('provider must not run'); };
  await assert.rejects(runUiParserTest(prepared, provider), /consent/);
  await assert.rejects(runUiParserTest({ ...prepared, preview: { ...prepared.preview, externalDataPolicyAccepted: true, providerConfigured: false } }, provider), /configured provider/);
  assert.equal(calls, 0, 'Missing consent or credentials must prevent any provider call.');
  const failure = new Error('network lost after submit');
  const accepted = { ...prepared, preview: { ...prepared.preview, externalDataPolicyAccepted: true, providerConfigured: true } };
  await assert.rejects(runUiParserTest(accepted, async () => { calls++; throw failure; }), error => error.cause === failure && /no automatic operator replay/.test(error.message));
  assert.equal(calls, 1, 'Unknown provider outcomes are reported once without a second chargeable call.');
}

async function publicationFailures(database) {
  await assert.rejects(uiResourcePublication('missing-resource'), /not found/);
  const configuration = (await listTradingStrategies()).find(item => item.status === 'published').configuration;
  const model = await createTradingStrategyDraft({ name: 'Archived dependency fixture', configuration });
  const wrapper = await createWorkflowResourceDraft({ kind: 'strategy', name: 'Unpublishable wrapper', configuration: { strategyVersionId: model.id } });
  const before = await uiResourcePublication(wrapper.id);
  await publishTradingStrategyVersion(model.id);
  await archiveTradingStrategyVersion(model.id);
  await assert.rejects(publishUiResourceWithDependency(wrapper.id, 0, before.publicationHash), /PUBLICATION_CONFLICT/);
  const archived = await uiResourcePublication(wrapper.id);
  await assert.rejects(publishUiResourceWithDependency(wrapper.id, 0, archived.publicationHash), /Archived model/);
  assert.equal((await getWorkflowResourceById(wrapper.id)).status, 'draft');
  assert.equal((await getTradingStrategyVersion(model.id)).status, 'archived');
  // Simulate an imported legacy wrapper whose pinned dependency is unavailable.
  await database.run('DELETE FROM trading_strategy_versions WHERE id=?', [model.id]);
  const missing = await uiResourcePublication(wrapper.id);
  assert.equal(missing.dependencyRequired, true); assert.equal(missing.dependency, null);
  await assert.rejects(publishUiResourceWithDependency(wrapper.id, 0, missing.publicationHash), /model is unavailable/);
  assert.equal((await getWorkflowResourceById(wrapper.id)).status, 'draft');
}

try {
  await initDb(path.join(directory, 'fixture.db')); await seedTradingFixtures();
  const database = getDatabase();
  await observationFailures(database); await parserFailures(); await publicationFailures(database);
  console.log('Evidence freshness and partial failure, parser boundaries and publication dependency failures passed.');
} finally {
  await closeDb(); await rm(directory, { recursive: true, force: true });
}
