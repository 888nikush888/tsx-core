import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  closeDb,
  getDatabase,
  initDb,
  saveSignal,
} from '../src/db.js';
import {
  addDecimal,
  compareDecimal,
  decimal,
  divideDecimal,
  midpointDecimal,
  multiplyDecimal,
  subtractDecimal,
} from '../src/trading_decimal.js';
import {
  DEFAULT_STRATEGY_CONFIGURATION,
  validateStrategyConfiguration,
} from '../src/trading_strategy.js';
import {
  createTradingIntent,
  createTradingStrategyDraft,
  ensureTradingDefaults,
  getTradingOverview,
  listTradingAccounts,
  listTradingRoutes,
  listTradingStrategies,
  publishTradingStrategyVersion,
  setTradingRoute,
  updateTradingRuntimeState,
  updateTradingStrategyDraft,
} from '../src/trading_repository.js';
import { validateSignalXml } from '../src/signal_schema.js';

const STANDARD_SIGNAL = `<signal>
<action>LONG</action>
<pair>BTCUSDT</pair>
<entry_range><min>60000</min><max>61000</max></entry_range>
<targets><target id="1">62000</target><target id="2">63000</target></targets>
<stoploss>59000</stoploss>
<leverage>3</leverage>
</signal>`;

function configuration(risk = '1') {
  return structuredClone({
    ...DEFAULT_STRATEGY_CONFIGURATION,
    sizing: { ...DEFAULT_STRATEGY_CONFIGURATION.sizing, riskPerTradePercent: risk },
  });
}

async function run() {
  assert.throws(() => decimal('001'), /Invalid unsigned decimal/);
  assert.equal(decimal('1.2300'), '1.23');
  assert.equal(compareDecimal('1.10', '1.1'), 0);
  assert.equal(addDecimal('0.1', '0.2'), '0.3');
  assert.equal(subtractDecimal('5', '1.25'), '3.75');
  assert.equal(multiplyDecimal('1.25', '4'), '5');
  assert.equal(divideDecimal('1', '8'), '0.125');
  assert.equal(midpointDecimal({ min: '60000', max: '61000' }), '60500');
  assert.throws(() => subtractDecimal('1', '2'), /negative/);

  const invalidAllocation = configuration();
  invalidAllocation.exits.targetAllocationsPercent = ['50', '49'];
  assert.throws(() => validateStrategyConfiguration(invalidAllocation), /exactly 100/);
  const invalidStopPolicy = configuration();
  invalidStopPolicy.safety.requireProtectiveStop = false;
  assert.throws(() => validateStrategyConfiguration(invalidStopPolicy), /mandatory/);
  const invalidRemainderPolicy = configuration();
  invalidRemainderPolicy.exits.closeRemainderAtLastTarget = false;
  assert.throws(() => validateStrategyConfiguration(invalidRemainderPolicy), /full remainder.*mandatory/);

  const directory = await mkdtemp(path.join(os.tmpdir(), 'trading-core-'));
  try {
    await initDb(path.join(directory, 'forwarder.db'));
    await ensureTradingDefaults(1_700_000_000_000);
    const defaults = await listTradingStrategies();
    const accounts = await listTradingAccounts();
    assert.equal(defaults.length, 1);
    assert.equal(defaults[0].status, 'published');
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].mode, 'paper');

    const draft = await createTradingStrategyDraft({
      name: 'Second channel strategy',
      configuration: configuration('0.5'),
    });
    const edited = await updateTradingStrategyDraft(draft.id, {
      name: draft.name,
      description: 'Different immutable strategy for a parallel channel.',
      configuration: configuration('0.75'),
    });
    assert.equal(edited.configuration.sizing.riskPerTradePercent, '0.75');
    const published = await publishTradingStrategyVersion(draft.id, 1_700_000_000_100);
    await assert.rejects(
      updateTradingStrategyDraft(published.id, {
        name: published.name,
        configuration: configuration('2'),
      }),
      /Only an existing draft/,
    );
    await assert.rejects(
      getDatabase().run(`UPDATE trading_strategy_versions SET name = 'tampered' WHERE id = ?`, [published.id]),
      /immutable/,
    );

    await setTradingRoute({
      channelId: '-100001',
      strategyVersionId: defaults[0].id,
      accountId: accounts[0].id,
      enabled: true,
    });
    await setTradingRoute({
      channelId: '-100002',
      strategyVersionId: published.id,
      accountId: accounts[0].id,
      enabled: true,
    });
    const routes = await listTradingRoutes();
    assert.equal(routes.length, 2, 'Two channels must route in parallel.');
    assert.notEqual(routes[0].strategyVersionId, routes[1].strategyVersionId);

    const validated = validateSignalXml(STANDARD_SIGNAL, 'default');
    assert.ok(validated.execution);
    await saveSignal('signal-1', '-100001', 1, STANDARD_SIGNAL, STANDARD_SIGNAL);
    const disabledIntent = await createTradingIntent({
      sourceSignalId: 'signal-1',
      channelId: '-100001',
      signal: validated.execution,
    });
    assert.equal(disabledIntent.status, 'blocked');
    assert.equal(disabledIntent.blockReason, 'EXECUTION_DISABLED');

    await updateTradingRuntimeState({ executionEnabled: true });
    await saveSignal('signal-2', '-100002', 2, STANDARD_SIGNAL, STANDARD_SIGNAL);
    const enabledIntent = await createTradingIntent({
      sourceSignalId: 'signal-2',
      channelId: '-100002',
      signal: validated.execution,
    });
    assert.equal(enabledIntent.status, 'pending');
    assert.equal(enabledIntent.strategyVersionId, published.id);

    const overview = await getTradingOverview();
    assert.equal(overview.enabledRouteCount, 2);
    assert.equal(overview.pendingIntentCount, 1);
    assert.equal(overview.runtime.executionEnabled, true);
  } finally {
    await closeDb();
    await rm(directory, { recursive: true, force: true });
  }
  console.log('Trading core tests passed.');
}

await run();
