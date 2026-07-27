import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, initDb } from '../src/db.js';
import { PaperExchangeAdapter } from '../src/paper_exchange.js';
import { TradingCredentialStore } from '../src/trading_credentials.js';
import { TradingEngine } from '../src/trading_engine.js';
import { ensureTradingDefaults } from '../src/trading_repository.js';
import { BUILTIN_SIGNAL_CONTRACTS } from '../src/signal_contract.js';
import { DEFAULT_STRATEGY_CONFIGURATION } from '../src/trading_strategy.js';
import { TradingWebControl } from '../src/trading_web_control.js';

class FakeOfficialAdapter {
  constructor(exchange) {
    this.exchange = exchange;
    this.snapshotCalls = 0;
    this.externalAccountId = exchange === 'bybit' ? 'a'.repeat(64) : 'b'.repeat(64);
    this.candidateExternalAccountId = null;
    this.remote = {
      orders: [], positions: [], fills: [], observedAt: Date.now(),
      accountFingerprint: this.externalAccountId,
    };
  }
  verified = true;
  verificationError = null;
  async verifyAccount(account) {
    if (this.verificationError) throw this.verificationError;
    return {
      verified: this.verified,
      equity: '1000',
      externalAccountId: account.id.startsWith('candidate-')
        ? (this.candidateExternalAccountId || this.externalAccountId)
        : this.externalAccountId,
    };
  }
  async accountSnapshot() {
    this.snapshotCalls += 1;
    return { equity: '1000', availableBalance: '900', unrealizedPnl: '25', marginUsed: '100', fundingPnlToday: '-1' };
  }
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
  assert.deepEqual(
    initial.signalSchemas.map(schema => schema.id).sort(),
    ['cryptodanielvip', 'loma', 'standard'],
  );
  assert.equal(initial.analytics.accounts.length, 1);
  assert.equal('credentialRef' in initial.accounts[0], false, 'Credential references must not reach the browser.');
  assert.equal(initial.confirmations.live, 'ENABLE LIVE TRADING');
  const initialPortfolio = await control.portfolioSnapshot(true);
  assert.equal(initialPortfolio.cached, false);
  assert.deepEqual(initialPortfolio.accounts.map(account => account.exchange), ['paper']);
  assert.equal(initialPortfolio.accounts[0].reportingCurrency, 'QUOTE');
  assert.equal(initialPortfolio.accounts[0].equity, '10000');
  assert.equal((await control.portfolioSnapshot()).cached, true);
  assert.throws(() => control.createStrategy({
    name: '', configuration: structuredClone(DEFAULT_STRATEGY_CONFIGURATION),
  }), /Strategy name is invalid/);
  const customSchema = await control.createSignalSchema({
    id: 'web-desk',
    name: 'Web Desk',
    description: 'Created through the Web control plane.',
    parserSchema: 'standard',
    templateName: 'web-desk-template',
    enabled: true,
  });
  assert.equal(customSchema.id, 'web-desk');
  const editedSchema = await control.updateSignalSchema({
    ...customSchema,
    name: 'Web Desk edited',
    description: 'Updated through the Web control plane.',
    contractVersionId: 'cryptodanielvip:v1',
    templateName: 'web-desk-v2',
    enabled: false,
  });
  assert.equal(editedSchema.enabled, false);
  assert.equal(editedSchema.parserSchema, 'cryptodanielvip');
  assert.equal((await control.snapshot()).signalSchemas.some(schema => schema.id === 'web-desk'), true);
  assert.equal(await control.removeSignalSchema('web-desk'), true);
  const contractDefinition = structuredClone(
    BUILTIN_SIGNAL_CONTRACTS.find(contract => contract.id === 'standard').definition,
  );
  const webContract = await control.createSignalContract({
    id: 'web-contract',
    name: 'Web Contract',
    description: 'Managed through the Web control plane.',
    definition: contractDefinition,
  });
  const webContractDraft = webContract.versions[0];
  await control.updateSignalContract({
    contractId: webContract.id,
    versionId: webContractDraft.id,
    name: 'Web Contract edited',
    description: 'Updated through the Web control plane.',
    definition: contractDefinition,
  });
  const preview = control.validateSignalContract({
    definition: contractDefinition,
    xml: '<signal><action>LONG</action><pair>BTCUSD</pair><entry_range><min>100</min><max>101</max></entry_range><targets><target id="1">110</target></targets><stoploss>90</stoploss></signal>',
    sourceText: 'LONG BTCUSD entry 100 101 target 110 stop 90',
  });
  assert.equal(preview.execution.symbol, 'BTCUSD');
  const publishedContract = await control.publishSignalContract(webContractDraft.id);
  const nextContractDraft = await control.createSignalContractVersion({
    contractId: webContract.id,
    sourceVersionId: publishedContract.id,
  });
  assert.equal(await control.removeSignalContractDraft(nextContractDraft.id), true);
  const duplicatedContract = await control.duplicateSignalContract({
    sourceVersionId: publishedContract.id,
    id: 'web-contract-copy',
    name: 'Web Contract Copy',
    description: 'Duplicated through the Web control plane.',
  });
  assert.equal(await control.removeSignalContractDraft(duplicatedContract.versions[0].id), true);
  assert.equal((await control.archiveSignalContract(publishedContract.id)).status, 'archived');
  assert.equal(await control.removeSignalContractVersion(publishedContract.id), true);
  assert.equal((await control.snapshot()).signalContracts.some(contract => contract.id === webContract.id), false);
  const channelPolicy = await control.setChannelRiskPolicy({
    channelId: '-100-web-risk',
    mode: 'fixed',
    tiers: [{ riskPercent: '0.5' }, { riskPercent: '1' }],
    currentTier: 0,
    lookbackWeeks: 2,
    minimumClosedTrades: 3,
    lossThresholdPercent: '1',
    profitThresholdPercent: '1',
    weakChannelAction: 'reduce',
    weakWeeksBeforeBlock: 2,
  });
  assert.equal(channelPolicy.channelId, '-100-web-risk');
  assert.equal(await control.removeChannelRiskPolicy(channelPolicy.channelId), true);
  await assert.rejects(control.setRuntime({ action: 'execution', enabled: true }), /at least one enabled channel route/);
  await assert.rejects(
    control.setRuntime({ action: 'live', enabled: true, confirmation: 'ENABLE LIVE TRADING' }),
    /at least one enabled, verified live account/,
  );
  await assert.rejects(control.setRuntime({ action: 'unsupported' }), /Unsupported trading runtime action/);

  const deletable = await control.createStrategy({
    name: 'Delete through control plane',
    configuration: structuredClone(DEFAULT_STRATEGY_CONFIGURATION),
  });
  assert.equal(await control.removeStrategy(deletable.id), true);
  assert.equal((await control.snapshot()).strategies.some(strategy => strategy.id === deletable.id), false);

  const second = await control.createStrategy({
    name: 'Parallel strategy',
    configuration: structuredClone(DEFAULT_STRATEGY_CONFIGURATION),
  });
  await control.updateStrategy({
    id: second.id,
    name: 'Parallel strategy edited',
    description: 'Edited through the Web control contract.',
    configuration: structuredClone(DEFAULT_STRATEGY_CONFIGURATION),
  });
  await control.publishStrategy(second.id);
  const nextVersion = await control.createStrategy({
    strategyId: second.strategyId,
    name: 'Parallel strategy v2',
    description: 'Version branch',
    configuration: structuredClone(DEFAULT_STRATEGY_CONFIGURATION),
  });
  await control.publishStrategy(nextVersion.id);
  await control.archiveStrategy(nextVersion.id);
  const archiveCandidate = await control.createStrategy({
    name: 'Archive candidate', configuration: structuredClone(DEFAULT_STRATEGY_CONFIGURATION),
  });
  await control.publishStrategy(archiveCandidate.id);
  assert.equal((await control.archiveStrategy(archiveCandidate.id)).status, 'archived');
  const published = (await control.snapshot()).strategies.filter(strategy => strategy.status === 'published');
  const paperAccount = initial.accounts[0];
  assert.throws(() => control.setRoute({
    channelId: '-invalid', strategyVersionId: published[0].id,
    accountId: paperAccount.id, enabled: 'yes',
  }), /must be boolean/);
  const extraPaper = await control.createAccount({ name: 'Extra Paper', exchange: 'paper', mode: 'paper' });
  assert.equal((await control.verifyAccount(extraPaper.id)).status, 'ready');
  await assert.rejects(
    control.replaceAccountCredentials({ id: extraPaper.id, credentials: {} }),
    /Paper accounts do not have exchange credentials/,
  );
  await control.removeAccount(extraPaper.id);
  await control.setRoute({ channelId: '-100001', strategyVersionId: published[0].id, accountId: paperAccount.id, enabled: true });
  await control.setRoute({ channelId: '-100002', strategyVersionId: second.id, accountId: paperAccount.id, enabled: true });
  await control.setRoute({ channelId: '-100099', strategyVersionId: second.id, accountId: paperAccount.id, enabled: true });
  await assert.rejects(control.removeStrategy(second.id), /channel routes/);
  assert.equal(await control.removeRoute('-100099'), true);
  assert.equal((await control.snapshot()).routes.length, 2, 'Independent channels must run distinct strategy versions in parallel.');

  await control.configurePaper({
    accountId: paperAccount.id,
    equity: '15000',
    availableBalance: '14000',
    market: { symbol: 'BTC', markPrice: '60000', priceTick: '0.1', quantityStep: '0.001', minimumQuantity: '0.001', minimumNotional: '10', maxLeverage: 20 },
  });
  await control.configurePaper({
    accountId: paperAccount.id,
    market: { symbol: 'ETH', markPrice: '3000', priceTick: '0.1', quantityStep: '0.001', minimumQuantity: '0.001', minimumNotional: '10', maxLeverage: 20 },
  });
  assert.equal((await control.snapshot()).activity.paperMarkets[0].markPrice, '60000');
  await control.setRuntime({ action: 'execution', enabled: true });
  assert.equal((await control.snapshot()).overview.runtime.executionEnabled, true);

  const live = await control.createAccount({
    name: 'Bybit Live', exchange: 'bybit', mode: 'live',
    credentials: { apiKey: 'official-api-key', apiSecret: 'official-api-secret' },
  });
  const livePortfolio = await control.portfolioSnapshot(true);
  const liveSnapshot = livePortfolio.accounts.find(account => account.accountId === live.id);
  assert.deepEqual(liveSnapshot && {
    reportingCurrency: liveSnapshot.reportingCurrency,
    equity: liveSnapshot.equity,
    availableBalance: liveSnapshot.availableBalance,
    unrealizedPnl: liveSnapshot.unrealizedPnl,
    marginUsed: liveSnapshot.marginUsed,
    error: liveSnapshot.error,
  }, { reportingCurrency: 'USD', equity: '1000', availableBalance: '900', unrealizedPnl: '25', marginUsed: '100', error: null });
  const callsAfterLiveRefresh = bybit.snapshotCalls;
  assert.equal((await control.portfolioSnapshot()).cached, true);
  assert.equal(bybit.snapshotCalls, callsAfterLiveRefresh, 'Cached dashboard refresh must not call the exchange again.');
  await control.portfolioSnapshot(true);
  assert.equal(bybit.snapshotCalls, callsAfterLiveRefresh + 1, 'Forced dashboard refresh must call the official adapter.');
  await assert.rejects(control.configurePaper({ accountId: live.id }), /requires a paper account/);
  await assert.rejects(control.setAccountEnabled(live.id, 'yes'), /must be boolean/);
  await control.replaceAccountCredentials({
    id: live.id,
    credentials: { apiKey: 'replacement-api-key', apiSecret: 'replacement-api-secret' },
  });
  bybit.candidateExternalAccountId = 'c'.repeat(64);
  await assert.rejects(control.replaceAccountCredentials({
    id: live.id,
    credentials: { apiKey: 'wrong-account-key', apiSecret: 'wrong-account-secret' },
  }), /different external exchange account/);
  bybit.candidateExternalAccountId = null;
  assert.equal((await control.setAccountEnabled(live.id, false)).status, 'disabled');
  assert.equal((await control.setAccountEnabled(live.id, true)).status, 'ready');
  const removable = await control.createAccount({
    name: 'Removable Bybit', exchange: 'bybit', mode: 'testnet',
    credentials: { apiKey: 'removable-api-key', apiSecret: 'removable-api-secret' },
  });
  await control.removeAccount(removable.id);
  const hyperliquidAccount = await control.createAccount({
    name: 'Removable Hyperliquid', exchange: 'hyperliquid', mode: 'testnet',
    credentials: { privateKey: `0x${'a'.repeat(64)}`, walletAddress: `0x${'b'.repeat(40)}` },
  });
  await control.removeAccount(hyperliquidAccount.id);
  bybit.verified = false;
  await assert.rejects(control.createAccount({
    name: 'Rejected account', exchange: 'bybit', mode: 'testnet',
    credentials: { apiKey: 'rejected-api-key', apiSecret: 'rejected-api-secret' },
  }), /rejected account verification/);
  bybit.verified = true;
  await assert.rejects(control.verifyAccount('missing-account'), /does not exist/);
  const redacted = JSON.stringify(await control.snapshot());
  assert.doesNotMatch(redacted, /official-api-(key|secret)/, 'Exchange credentials must never be returned.');
  await control.setRoute({ channelId: '-100003', strategyVersionId: published[0].id, accountId: live.id, enabled: true });
  await assert.rejects(control.setRuntime({ action: 'live', enabled: true, confirmation: 'yes' }), /exact confirmation/);
  await control.setRuntime({ action: 'live', enabled: true, confirmation: 'ENABLE LIVE TRADING' });
  assert.equal((await control.snapshot()).overview.runtime.liveTradingEnabled, true);

  await control.setRuntime({ action: 'kill-switch', active: true, reason: 'Contract test' });
  await assert.rejects(control.setRuntime({ action: 'execution', enabled: true }), /kill switch is active/);
  let runtime = (await control.snapshot()).overview.runtime;
  assert.equal(runtime.killSwitchActive, true);
  assert.equal(runtime.executionEnabled, false);
  await control.setRuntime({ action: 'kill-switch', active: false });
  runtime = (await control.snapshot()).overview.runtime;
  assert.equal(runtime.killSwitchActive, false);

  await control.reconcile();
  await control.reconcile(paperAccount.id);
  assert.equal(await control.cancelEntries(), 0);
  assert.equal(await control.cancelEntries(paperAccount.id), 0);
  assert.equal(await control.acknowledgeRisk('missing-risk-event'), false);
  await assert.rejects(control.emergencyFlatten({ confirmation: 'wrong' }), /exact confirmation/);
  assert.equal(await control.emergencyFlatten({
    accountId: paperAccount.id,
    confirmation: 'FLATTEN MANAGED POSITIONS',
  }), 0);
  assert.equal(await control.emergencyFlatten({ confirmation: 'FLATTEN MANAGED POSITIONS' }), 0);
  await control.assertFactoryResetSafe();

  bybit.remote.positions.push({ symbol: 'BTC', side: 'LONG', quantity: '1', averageEntryPrice: '60000', unrealizedPnl: '0' });
  await assert.rejects(control.assertFactoryResetSafe(), /open orders or positions/);
} finally {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}

console.log('Trading web control tests passed.');
