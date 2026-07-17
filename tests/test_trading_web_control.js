import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, initDb } from '../src/db.js';
import { PaperExchangeAdapter } from '../src/paper_exchange.js';
import { TradingCredentialStore } from '../src/trading_credentials.js';
import { TradingEngine } from '../src/trading_engine.js';
import { ensureTradingDefaults } from '../src/trading_repository.js';
import { DEFAULT_STRATEGY_CONFIGURATION } from '../src/trading_strategy.js';
import { TradingWebControl } from '../src/trading_web_control.js';

class FakeOfficialAdapter {
  constructor(exchange) { this.exchange = exchange; }
  remote = { orders: [], positions: [], fills: [], observedAt: Date.now() };
  async verifyAccount() { return { verified: true, equity: '1000' }; }
  async accountSnapshot() { return { equity: '1000', availableBalance: '1000' }; }
  async marketSnapshot(_account, symbol) {
    return { symbol, markPrice: '100', priceTick: '0.1', quantityStep: '0.001', minimumQuantity: '0.001', minimumNotional: '10', maxLeverage: 20, observedAt: Date.now() };
  }
  async submitOrder() { throw new Error('Not used by control-plane contract test.'); }
  async cancelOrder() { throw new Error('Not used by control-plane contract test.'); }
  async openState() { return structuredClone(this.remote); }
}

const directory = await mkdtemp(path.join(os.tmpdir(), 'trading-web-control-'));
try {
  await initDb(path.join(directory, 'forwarder.db'));
  await ensureTradingDefaults();
  const credentials = new TradingCredentialStore(path.join(directory, 'secrets'));
  await credentials.initialize();
  const paper = new PaperExchangeAdapter();
  const hyperliquid = new FakeOfficialAdapter('hyperliquid');
  const bybit = new FakeOfficialAdapter('bybit');
  const engine = new TradingEngine([paper, hyperliquid, bybit]);
  const control = new TradingWebControl(credentials, paper, [hyperliquid, bybit], engine);

  const initial = await control.snapshot();
  assert.equal(initial.accounts.length, 1);
  assert.equal('credentialRef' in initial.accounts[0], false, 'Credential references must not reach the browser.');
  assert.equal(initial.confirmations.live, 'ENABLE LIVE TRADING');

  const second = await control.createStrategy({
    name: 'Parallel strategy',
    configuration: structuredClone(DEFAULT_STRATEGY_CONFIGURATION),
  });
  await control.publishStrategy(second.id);
  const published = (await control.snapshot()).strategies.filter(strategy => strategy.status === 'published');
  const paperAccount = initial.accounts[0];
  await control.setRoute({ channelId: '-100001', strategyVersionId: published[0].id, accountId: paperAccount.id, enabled: true });
  await control.setRoute({ channelId: '-100002', strategyVersionId: second.id, accountId: paperAccount.id, enabled: true });
  assert.equal((await control.snapshot()).routes.length, 2, 'Independent channels must run distinct strategy versions in parallel.');

  await control.configurePaper({
    accountId: paperAccount.id,
    equity: '15000',
    availableBalance: '14000',
    market: { symbol: 'BTC', markPrice: '60000', priceTick: '0.1', quantityStep: '0.001', minimumQuantity: '0.001', minimumNotional: '10', maxLeverage: 20 },
  });
  assert.equal((await control.snapshot()).activity.paperMarkets[0].markPrice, '60000');
  await control.setRuntime({ action: 'execution', enabled: true });
  assert.equal((await control.snapshot()).overview.runtime.executionEnabled, true);

  const live = await control.createAccount({
    name: 'Bybit Live', exchange: 'bybit', mode: 'live',
    credentials: { apiKey: 'official-api-key', apiSecret: 'official-api-secret' },
  });
  const redacted = JSON.stringify(await control.snapshot());
  assert.doesNotMatch(redacted, /official-api-(key|secret)/, 'Exchange credentials must never be returned.');
  await control.setRoute({ channelId: '-100003', strategyVersionId: published[0].id, accountId: live.id, enabled: true });
  await assert.rejects(control.setRuntime({ action: 'live', enabled: true, confirmation: 'yes' }), /exact confirmation/);
  await control.setRuntime({ action: 'live', enabled: true, confirmation: 'ENABLE LIVE TRADING' });
  assert.equal((await control.snapshot()).overview.runtime.liveTradingEnabled, true);

  await control.setRuntime({ action: 'kill-switch', active: true, reason: 'Contract test' });
  let runtime = (await control.snapshot()).overview.runtime;
  assert.equal(runtime.killSwitchActive, true);
  assert.equal(runtime.executionEnabled, false);
  await control.setRuntime({ action: 'kill-switch', active: false });
  runtime = (await control.snapshot()).overview.runtime;
  assert.equal(runtime.killSwitchActive, false);

  bybit.remote.positions.push({ symbol: 'BTC', side: 'LONG', quantity: '1', averageEntryPrice: '60000', unrealizedPnl: '0' });
  await assert.rejects(control.assertFactoryResetSafe(), /open orders or positions/);
} finally {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}

console.log('Trading web control tests passed.');
