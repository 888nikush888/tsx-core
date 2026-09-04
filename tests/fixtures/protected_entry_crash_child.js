import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';
import { getDatabase, initDb } from '../../src/db.js';
import { PaperExchangeAdapter } from '../../src/paper_exchange.js';
import { TradingEngine } from '../../src/trading_engine.js';

const [databasePath, intentId, phase, callsPath] = process.argv.slice(2);
await initDb(databasePath);

function park() {
  process.stdout.write(`PROTECTED_ENTRY_CRASH:${phase}\n`);
  setInterval(() => {}, 1_000);
  return new Promise(() => {});
}

class CrashPaper extends PaperExchangeAdapter {
  async submitProtectedEntry(account, entry, stop) {
    await appendFile(callsPath, `${JSON.stringify({ event: 'attempt', entry: entry.clientOrderId,
      stop: stop.clientOrderId, expiresAt: entry.entryExpiresAt })}\n`);
    if (phase === 'provider-before-accept') return park();
    const result = await super.submitProtectedEntry(account, entry, stop);
    await appendFile(callsPath, `${JSON.stringify({ event: 'accepted', entry: entry.clientOrderId, stop: stop.clientOrderId })}\n`);
    if (phase === 'accepted') return park();
    if (phase === 'roundtrip') {
      const market = await this.marketSnapshot(account, entry.symbol);
      await this.setMarket(account.id, { ...market, markPrice: '2800' });
      const remote = await this.openState(account);
      assert.equal(remote.positions.length, 0);
      assert.ok(remote.orders.some(order => order.clientOrderId === stop.clientOrderId && order.status === 'filled'));
      return park();
    }
    return result;
  }
}

function installDatabaseHook() {
  const database = getDatabase();
  const run = database.run.bind(database);
  database.run = async (...args) => {
    const result = await run(...args);
    if (phase === 'plan-before-commit' && args[0].includes('INSERT INTO trading_orders') && args[1]?.[1] === intentId) return park();
    if (args[0].includes('UPDATE trading_operations SET phase = ?')) {
      const next = args[1]?.[0];
      const operation = await database.get('SELECT kind, intent_id FROM trading_operations WHERE id = ?', [args[1]?.[4]]);
      if (operation?.kind !== 'protected_entry' || operation.intent_id !== intentId) return result;
      if ((phase === 'dispatching' && next === 'dispatching') || (phase === 'ack-before-commit' && next === 'acknowledged')) return park();
    }
    return result;
  };
}

function installEngineHook(engine) {
  const prepare = engine.preparePendingIntent.bind(engine);
  engine.preparePendingIntent = async (...args) => {
    const result = await prepare(...args);
    if (phase === 'planned') return park();
    return result;
  };
  const admission = engine.assertFinalEntryAdmission.bind(engine);
  engine.assertFinalEntryAdmission = async (...args) => {
    if (phase === 'prepared') return park();
    return admission(...args);
  };
  const outcome = engine.validateProtectedEntryOutcome.bind(engine);
  engine.validateProtectedEntryOutcome = async (...args) => {
    if (phase === 'acknowledged') return park();
    return outcome(...args);
  };
}

installDatabaseHook();
const engine = new TradingEngine([new CrashPaper()]);
installEngineHook(engine);
await engine.processIntent(intentId);
const row = await getDatabase().get('SELECT status, block_reason, error FROM trading_trade_intents WHERE id = ?', [intentId]);
throw new Error(`Protected-entry child did not reach ${phase}: ${JSON.stringify(row)}`);
