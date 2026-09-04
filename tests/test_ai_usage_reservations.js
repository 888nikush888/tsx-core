import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, initDb, reserveAiUsage, commitAiUsage, getAiUsage, getDatabase, pruneOperationalData } from '../src/db.js';
import { parseSignalToXml } from '../src/signal_parser.js';

const xml = '<signal><action>LONG</action><pair>BTCUSDT</pair><entry_range><min>90</min><max>90</max></entry_range><targets><target id="1">95</target></targets><stoploss>85</stoploss></signal>';

async function commitResponseFailure(afterCommit) {
  let providerCalls = 0;
  let commitCalls = 0;
  const charged = [];
  await parseSignalToXml('LONG BTCUSDT entry 90 target 95 stop 85', 'default', { primaryModel: 'local-fake' }, {
    promptTemplate: 'Extract signal',
    requestCompletion: async () => {
      providerCalls += 1;
      return { choices: [{ finish_reason: 'stop', message: { content: xml } }], usage: { total_tokens: 7 } };
    },
    budget: {
      reserve: reserveAiUsage,
      async commit(id, allowance, actual) {
        commitCalls += 1;
        charged.push([id, actual]);
        if (afterCommit || commitCalls > 1) await commitAiUsage(id, allowance, actual);
        if (commitCalls === 1) throw new Error('Injected ambiguous database commit response');
      }
    }
  });
  assert.equal(providerCalls, 1, 'A booking retry must not dispatch a second AI request.');
  assert.equal(commitCalls, 2);
  assert.deepEqual(charged[1], charged[0], 'Known usage and settlement identity must survive both failure sides.');
}

async function persistentCommitFailure() {
  let providerCalls = 0;
  let commitCalls = 0;
  await assert.rejects(parseSignalToXml('LONG BTCUSDT entry 90 target 95 stop 85', 'default', { primaryModel: 'local-fake', fallbackModel: 'local-fallback' }, {
    promptTemplate: 'Extract signal', limits: { backoffMs: 0 },
    requestCompletion: async () => {
      providerCalls += 1;
      return { choices: [{ finish_reason: 'stop', message: { content: xml } }], usage: { total_tokens: 9 } };
    },
    budget: { reserve: reserveAiUsage, commit: async (_id, _allowance, actual) => {
      commitCalls += 1;
      assert.equal(actual, 9);
      throw new Error('Injected unavailable DB');
    } }
  }), error => error.name === 'AiUsageSettlementError' && error.actualTokens === 9);
  assert.equal(providerCalls, 1);
  assert.equal(commitCalls, 3);
}

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-ai-reservations-'));
const databasePath = path.join(directory, 'test.db');
const previousKey = process.env.OPENROUTER_API_KEY;
process.env.OPENROUTER_API_KEY = 'local-test-no-network';
try {
  await initDb(databasePath);
  const reservation = await reserveAiUsage('2026-09-02', 600, 5, 2000);
  assert.equal(typeof reservation.id, 'string', 'Every provider attempt needs a durable reservation ID.');
  await commitAiUsage(reservation.id, 600, 450);
  await commitAiUsage(reservation.id, 600, 450);
  assert.deepEqual(await getAiUsage('2026-09-02'), { requestCount: 1, usedTokens: 450, reservedTokens: 0 });
  await assert.rejects(commitAiUsage(reservation.id, 600, 451), /conflict/i);
  const unknown = await reserveAiUsage('2026-09-02', 600, 5, 2000);
  assert.notEqual(unknown.id, reservation.id, 'A real new provider attempt gets a separate reservation.');
  await closeDb();
  await initDb(databasePath);
  assert.equal((await getAiUsage('2026-09-02')).reservedTokens, 600, 'Crash must not release unknown provider cost.');
  await reserveAiUsage('2026-09-03', 600, 5, 2000);
  assert.equal((await getAiUsage('2026-09-02')).reservedTokens, 600);
  await commitAiUsage(unknown.id, 600, null);
  await commitAiUsage(unknown.id, 600, null);
  assert.deepEqual(await getAiUsage('2026-09-02'), { requestCount: 2, usedTokens: 1050, reservedTokens: 0 });
  await commitResponseFailure(false);
  await commitResponseFailure(true);
  await persistentCommitFailure();
  const bound = (await getAiUsage(new Date().toISOString().slice(0, 10))).reservedTokens;
  assert.ok(bound > 0);
  await pruneOperationalData(1, 100, Date.now() + 86400000 * 365);
  assert.equal((await getAiUsage(new Date().toISOString().slice(0, 10))).reservedTokens, bound, 'Retention cannot erase unresolved usage.');
  assert.equal((await getDatabase().all('PRAGMA foreign_key_check')).length, 0);
  console.log('Durable AI reservation settlement passed.');
} finally {
  await closeDb();
  if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = previousKey;
  await rm(directory, { recursive: true, force: true });
}
