import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb, saveSignal } from '../src/db.js';
import { seedTradingFixtures } from './trading_fixtures.js';
import { PaperExchangeAdapter } from '../src/paper_exchange.js';
import { TradingEngine } from '../src/trading_engine.js';
import { invalidFx } from '../src/trading_fx_contract.js';
import { createTradingIntent, getTradingIntent, listTradingStrategies, setTradingRoute, updateTradingRuntimeState } from '../src/trading_repository.js';

for (const phase of ['before_dispatch', 'after_dispatch']) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-fx-engine-'));
  try {
    await initDb(path.join(directory, 'test.db')); await seedTradingFixtures();
    const [strategy] = await listTradingStrategies();
    await setTradingRoute({ channelId: '-fx-engine', accountId: 'paper-default', strategyVersionId: strategy.id, enabled: true });
    await updateTradingRuntimeState({ executionEnabled: true });
    await saveSignal('fx-engine', '-fx-engine', 1, '<signal/>', '<signal/>');
    const intent = await createTradingIntent({ sourceSignalId: 'fx-engine', channelId: '-fx-engine', signal: {
      schema: 'standard', action: 'LONG', symbol: 'BTCUSDT', entry: { type: 'market' }, stopLoss: '90',
      targets: [{ min: '110', max: '110' }, { min: '120', max: '120' }] } });
    const paper = new PaperExchangeAdapter();
    await paper.setMarket('paper-default', { symbol: 'BTCUSDT', markPrice: '100', priceTick: '0.1', quantityStep: '0.01',
      minimumQuantity: '0.01', minimumNotional: '1', maxLeverage: 10 });
    let sends = 0;
    if (phase === 'before_dispatch') paper.marketSnapshot = async () => invalidFx('SIZING_CONVERSION_UNPROVEN');
    paper.submitProtectedEntry = async () => { sends += 1; return invalidFx('SIZING_CONVERSION_UNPROVEN'); };
    await new TradingEngine([paper]).processIntent(intent.id);
    const actual = await getTradingIntent(intent.id);
    assert.equal(actual.status, phase === 'before_dispatch' ? 'blocked' : 'unknown', actual.error);
    assert.equal(actual.blockReason, phase === 'before_dispatch' ? 'FX_SIZING_CONVERSION_UNPROVEN' : null);
    const failure = await getDatabase().get('SELECT code FROM trading_risk_events WHERE intent_id=? ORDER BY created_at DESC LIMIT 1', [intent.id]);
    assert.equal(failure.code, phase === 'before_dispatch' ? 'FX_SIZING_CONVERSION_UNPROVEN' : 'ORDER_OUTCOME_UNKNOWN');
    assert.equal(sends, phase === 'before_dispatch' ? 0 : 1);
    const operations = await getDatabase().all('SELECT phase FROM trading_operations WHERE intent_id=?', [intent.id]);
    assert.deepEqual(operations, phase === 'before_dispatch' ? [] : [{ phase: 'unresolved' }]);
    assert.match(actual.error, /FX_SIZING_CONVERSION_UNPROVEN/);
  } finally {
    await closeDb(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); await rm(directory, { recursive: true, force: true });
  }
}
console.log('Typed pre-dispatch FX failures are blocked; a possible dispatch remains unknown and cannot be retried.');
