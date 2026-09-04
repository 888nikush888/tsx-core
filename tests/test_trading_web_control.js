import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { closeDb, getDatabase, initDb } from '../src/db.js';
import { PaperExchangeAdapter } from '../src/paper_exchange.js';
import { TradingCredentialStore } from '../src/trading_credentials.js';
import { TradingEngine } from '../src/trading_engine.js';
import { seedTradingFixtures } from './trading_fixtures.js';
import { BUILTIN_SIGNAL_CONTRACTS } from '../src/signal_contract.js';
import { DEFAULT_STRATEGY_CONFIGURATION } from '../src/trading_strategy.js';
import { TradingWebControl } from '../src/trading_web_control.js';
import { completeSafetyState } from './fixtures/safety_acquisition.js';
import { getAccountBaseline, requiredAccountEvidenceSince } from '../src/trading_account_baseline.js';
import { historyCheckpoints } from '../src/trading_history_repository.js';
import { getTradingAccount, getTradingRuntimeState } from '../src/trading_repository.js';

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
  credentialGeneration = 'c'.repeat(64);
  candidateCredentialGeneration = null;
  scopedCurrentReads = false;
  trace = [];
  async verifyAccount(account) {
    this.trace.push({ kind: 'verify', accountId: account.id });
    if (this.verificationError) throw this.verificationError;
    return {
      verified: this.verified,
      equity: '1000',
      credentialGeneration: account.id.startsWith('candidate-')
        ? (this.candidateCredentialGeneration ?? this.credentialGeneration) : this.credentialGeneration,
      externalAccountId: account.id.startsWith('candidate-')
        ? (this.candidateExternalAccountId || this.externalAccountId)
        : this.externalAccountId,
      capabilities: {
        reportingCurrency: this.exchange === 'hyperliquid' ? 'USDC' : 'USD',
      },
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
  async openState(account) {
    this.trace.push({ kind: 'read', accountId: account.id, statuses: this.remote.orders.map(order => order.status) });
    // Synthetic source evidence exercises the real control-plane safety consumers, not provider acceptance.
    const previous = (await historyCheckpoints(account, await requiredAccountEvidenceSince(account)))
      .find(checkpoint => checkpoint.source === 'fills');
    const state = completeSafetyState(structuredClone(this.remote));
    const now = state.observedAt;
    state.acquisition.history = [{ baseRevision: previous.revision, pages: 1, checkpoint: {
      ...previous, revision: previous.revision + 1, cursor: null, scannedThrough: now, completeness: 'complete', reason: null,
      coverage: { version: 1, profile: this.exchange === 'bybit' ? 'bybit_v5_linear_endpoint_v1' : 'hyperliquid_retained_fills_v1',
        since: previous.baselineSince, through: now },
    } }];
    if (this.scopedCurrentReads) {
      for (const source of state.acquisition.sources.filter(row => ['orders', 'positions'].includes(row.source))) {
        source.scopes = [{ scope: 'synthetic:account:all', pages: 1, complete: true }];
      }
    }
    return state;
  }
}

async function classifiedTerminalHistory(account, adapter, engine) {
  adapter.scopedCurrentReads = true;
  await engine.reconcileAccount(account.id);
  await delay(2); // The second original observation must begin strictly after the first completes.
  await engine.reconcileAccount(account.id);
  const baseline = await getAccountBaseline(await getTradingAccount(account.id));
  assert.ok(baseline, 'The real baseline consumer must establish the synthetic flat account boundary first.');
  adapter.remote.orders = ['filled', 'cancelled', 'rejected'].map((status, index) => ({
    exchangeOrderId: `historical-rotation-${index}`, clientOrderId: null, symbol: 'BTCUSDC', providerSymbol: 'BTC',
    role: 'entry', side: 'buy', status, quantity: '1', filledQuantity: status === 'filled' ? '1' : '0',
    price: '100', averagePrice: status === 'filled' ? '100' : null, triggerPrice: null, reduceOnly: false,
    providerTimestamp: baseline.boundary - 60_000 - index,
  }));
  await engine.reconcileAccount(account.id);
  const rows = await historicalCredentialEvidence(account.id);
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.classification, 'external', 'Old terminal originals must be classified, not dropped or relabelled owned.');
    assert.equal(row.external_baseline_id, baseline.id);
    assert.equal(row.account_fingerprint, account.externalAccountId);
  }
  return rows;
}

async function historicalCredentialEvidence(accountId) {
  return getDatabase().all(`SELECT id, account_fingerprint, provider_id, provider_symbol, identity_key, content_hash,
    payload_json, classification, external_baseline_id, first_seen_at FROM trading_remote_evidence
    WHERE account_id=? ORDER BY provider_id`, [accountId]);
}

async function openOrderPreventsCredentialPromotion({ account, adapter, engine, control, credentialPath, entryRuntime }) {
  const originalReconcile = engine.reconcileAccount;
  const terminalOrders = structuredClone(adapter.remote.orders);
  const storedBefore = await readFile(credentialPath, 'utf8');
  const filesBefore = (await readdir(path.dirname(credentialPath))).sort();
  adapter.trace = [];
  engine.reconcileAccount = async function (...args) {
    const result = await originalReconcile.apply(this, args);
    if (args[0] === account.id) {
      // A genuinely new open obligation appears after the real reconciliation, before the final maintenance read.
      adapter.remote.orders = [...terminalOrders, { ...terminalOrders[1], exchangeOrderId: 'rotation-late-open',
        status: 'open', providerTimestamp: Date.now() }];
    }
    return result;
  };
  try {
    await assert.rejects(control.replaceAccountCredentials({ id: account.id,
      credentials: { privateKey: `0x${'e'.repeat(64)}`, walletAddress: `0x${'b'.repeat(40)}` } }),
    /Credentials cannot be replaced while the exchange account has open orders or positions/);
    assert.ok(adapter.trace.filter(event => event.kind === 'read').at(-1).statuses.includes('open'));
    assert.equal(adapter.trace.filter(event => event.kind === 'verify').length, 1,
      'Only the old credential is verified; an active final read must prevent candidate staging/verification.');
    assert.equal(await readFile(credentialPath, 'utf8'), storedBefore, 'An open obligation must preserve the original credential file exactly.');
    assert.deepEqual((await readdir(path.dirname(credentialPath))).sort(), filesBefore, 'No staged candidate file may remain after the rejected rotation.');
    const current = await getTradingAccount(account.id);
    assert.equal(current.credentialGeneration, account.credentialGeneration);
    assert.equal(current.enabled, false);
    assert.equal((await getTradingRuntimeState()).killSwitchActive, true);
    assert.equal((await getTradingRuntimeState()).executionEnabled, false);
    assert.equal(entryRuntime.enabled, false);
  } finally {
    engine.reconcileAccount = originalReconcile;
    adapter.remote.orders = terminalOrders;
  }
  await control.verifyAccount(account.id);
}

async function terminalHistoryAllowsCredentialRotation({ account, adapter, engine, control, directory, entryRuntime }) {
  const originals = await classifiedTerminalHistory(account, adapter, engine);
  const terminalOrders = structuredClone(adapter.remote.orders);
  const credentialPath = path.join(directory, 'secrets', 'trading', `${account.id}.json`);
  const oldCredentials = JSON.parse(await readFile(credentialPath, 'utf8'));
  adapter.candidateCredentialGeneration = 'd'.repeat(64);
  adapter.trace = [];
  try {
    const rotated = await control.replaceAccountCredentials({ id: account.id,
      credentials: { privateKey: `0x${'c'.repeat(64)}`, walletAddress: `0x${'b'.repeat(40)}` } });
    assert.equal(rotated.externalAccountId, account.externalAccountId);
    assert.equal(rotated.credentialGeneration, 'd'.repeat(64));
    assert.equal(rotated.enabled, false);
    assert.equal(rotated.status, 'ready');
    const stored = JSON.parse(await readFile(credentialPath, 'utf8'));
    assert.notEqual(stored.credentials.privateKey, oldCredentials.credentials.privateKey);
    assert.equal(stored.credentials.privateKey, `0x${'c'.repeat(64)}`);
    assert.equal(adapter.trace[0].kind, 'verify');
    assert.equal(adapter.trace[0].accountId, account.id, 'Old binding is verified before any maintenance read.');
    assert.ok(adapter.trace.at(-1).accountId.startsWith('candidate-'));
    const reads = adapter.trace.filter(event => event.kind === 'read');
    assert.ok(reads.length >= 3, 'Real drain/reconciliation and the final maintenance read all run.');
    assert.ok(reads.every(event => event.statuses.join(',') === 'filled,cancelled,rejected'));
    assert.deepEqual(adapter.remote.orders, terminalOrders);
    assert.deepEqual(await historicalCredentialEvidence(account.id), originals, 'Original IDs, payloads and classification survive rotation.');
    assert.equal((await getTradingRuntimeState()).killSwitchActive, true);
    assert.equal((await getTradingRuntimeState()).executionEnabled, false);
    assert.equal(entryRuntime.enabled, false);
    adapter.credentialGeneration = rotated.credentialGeneration;
    await openOrderPreventsCredentialPromotion({ account: rotated, adapter, engine, control, credentialPath, entryRuntime });
    assert.deepEqual(await historicalCredentialEvidence(account.id), originals);
    assert.deepEqual(await getDatabase().all('PRAGMA foreign_key_check'), []);
  } finally {
    adapter.candidateCredentialGeneration = null;
    adapter.scopedCurrentReads = false;
    adapter.remote.orders = [];
  }
}

const directory = await mkdtemp(path.join(os.tmpdir(), 'trading-web-control-'));
try {
  await initDb(path.join(directory, 'forwarder.db'));
  await seedTradingFixtures();
  const credentials = new TradingCredentialStore(path.join(directory, 'secrets'));
  await credentials.initialize();
  const paper = new PaperExchangeAdapter();
  const hyperliquid = new FakeOfficialAdapter('hyperliquid');
  const bybit = new FakeOfficialAdapter('bybit');
  const engine = new TradingEngine([paper, hyperliquid, bybit]);
  const entryRuntime = {
    enabled: false,
    enableCalls: 0,
    disableCalls: 0,
    failNextEnable: false,
    async enableEntries() {
      this.enableCalls += 1;
      if (this.failNextEnable) {
        this.failNextEnable = false;
        throw new Error('simulated entry latch failure');
      }
      this.enabled = true;
    },
    disableEntries() {
      this.disableCalls += 1;
      this.enabled = false;
    },
  };
  const catalogEntries = [
    {
      id: 'paper', name: 'Paper Trading', status: 'certified', reason: null, provider: 'paper',
      ccxt: null, markets: { linearSwap: true }, credentialFields: [], modes: ['paper'], capabilities: {},
    },
    {
      id: 'hyperliquid', name: 'Hyperliquid', status: 'certified', reason: null, provider: 'ccxt',
      ccxt: { rest: true, pro: true }, markets: { linearSwap: true },
      credentialFields: [
        { id: 'privateKey', label: 'Private Key', required: true, secret: true },
        { id: 'walletAddress', label: 'Wallet Address', required: true, secret: false },
      ],
      modes: ['testnet', 'live'], capabilities: {},
    },
    {
      id: 'bybit', name: 'Bybit', status: 'certified', reason: null, provider: 'ccxt',
      ccxt: { rest: true, pro: true }, markets: { linearSwap: true },
      credentialFields: [
        { id: 'apiKey', label: 'API Key', required: true, secret: true },
        { id: 'secret', label: 'API Secret', required: true, secret: true },
      ],
      modes: ['testnet', 'live'], capabilities: {},
    },
  ];
  const catalog = {
    browserCatalog: async () => ({
      implementation: { library: 'ccxt', version: '4.5.75', streaming: 'ccxt-pro', orderAuthority: 'rest' },
      exchanges: catalogEntries,
    }),
    probe: async exchange => catalogEntries.find(entry => entry.id === exchange),
  };
  const control = new TradingWebControl(
    credentials, paper, [hyperliquid, bybit], engine, entryRuntime, catalog,
  );
  control.attachEntryRuntime(entryRuntime);
  assert.throws(
    () => control.attachEntryRuntime({ enableEntries: async () => {}, disableEntries: () => {} }),
    /already attached/,
  );

  const initial = await control.snapshot();
  assert.equal(initial.accounts.length, 1);
  assert.deepEqual(
    initial.signalSchemas.map(schema => schema.id).sort(),
    ['cryptodanielvip', 'loma', 'standard'],
  );
  assert.equal(initial.analytics.accounts.length, 1);
  assert.deepEqual(initial.fallbackRuns, []);
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
  assert.equal(editedSchema.parserSchema, 'standard',
    'Changing the fallback contract must not silently replace the explicitly selected parser schema.');
  assert.equal(editedSchema.contractVersionId, 'cryptodanielvip:v1');
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
  await assert.rejects(
    control.createAccount({ name: 'Implicit Paper', exchange: 'paper', mode: 'paper' }),
    /explicitly entered initial balance/,
  );
  const extraPaper = await control.createAccount({
    name: 'Extra Paper', exchange: 'paper', mode: 'paper', initialBalance: '25000',
  });
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

  const limitedPaper = await control.configureAccount({
    id: paperAccount.id,
    maxConcurrentPositions: 7,
    killSwitchActive: true,
    killSwitchReason: 'Account maintenance',
  });
  assert.equal(limitedPaper.maxConcurrentPositions, 7);
  assert.equal(limitedPaper.killSwitchActive, true);
  await assert.rejects(
    control.configureAccount({ id: paperAccount.id, killSwitchActive: false }),
    /kill-switch release confirmation/,
  );
  const resizedPaper = await control.configureAccount({
    id: paperAccount.id,
    maxConcurrentPositions: 5,
  });
  assert.equal(resizedPaper.maxConcurrentPositions, 5);
  assert.equal(resizedPaper.killSwitchActive, true);
  const releasedPaper = (await control.releaseAccountKillSwitch({
    id: paperAccount.id,
    confirmation: 'RELEASE ACCOUNT KILL SWITCH',
  })).account;
  assert.equal(releasedPaper.killSwitchActive, false);

  const workflowDraft = await control.createWorkflowResource({
    kind: 'channel', name: 'Control channel', configuration: { channelId: '-100-control' },
  });
  const workflowUpdated = await control.updateWorkflowResource({
    id: workflowDraft.id, name: 'Control channel updated', description: '',
    configuration: { channelId: '-100-control' },
  });
  assert.equal(workflowUpdated.name, 'Control channel updated');
  const workflowPublished = await control.publishWorkflowResource(workflowDraft.id);
  assert.equal(workflowPublished.status, 'published');
  assert.equal((await control.archiveWorkflowResource(workflowPublished.id)).status, 'archived');
  const disposableWorkflowDraft = await control.createWorkflowResource({
    kind: 'channel', name: 'Disposable control draft', configuration: { channelId: '-100-disposable' },
  });
  assert.equal(await control.deleteWorkflowResourceDraft(disposableWorkflowDraft.id), true);

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
  assert.equal(entryRuntime.enabled, true, 'A successful dashboard enable must open the in-memory entry latch.');
  assert.equal(entryRuntime.enableCalls, 1);

  const bybitPortfolioAccount = await control.createAccount({
    name: 'Bybit Live', exchange: 'bybit', mode: 'live',
    credentials: { apiKey: 'official-api-key', secret: 'official-api-secret' },
  });
  const livePortfolio = await control.portfolioSnapshot(true);
  const liveSnapshot = livePortfolio.accounts.find(account => account.accountId === bybitPortfolioAccount.id);
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
  await assert.rejects(control.configurePaper({ accountId: bybitPortfolioAccount.id }), /requires a paper account/);
  await assert.rejects(control.setAccountEnabled(bybitPortfolioAccount.id, 'yes'), /must be boolean/);
  await assert.rejects(control.replaceAccountCredentials({
    id: bybitPortfolioAccount.id,
    credentials: { apiKey: 'replacement-api-key', secret: 'replacement-api-secret' },
  }), error => error instanceof AggregateError && error.errors.some(cause => /FILL_OPTION_SCOPE_UNPROVED/.test(cause.message)),
  'Linear endpoint EOF cannot authorize credential replacement for an account with unproved option history.');
  await control.removeAccount(bybitPortfolioAccount.id);
  // Positive generic credential-maintenance tests use a separate, explicitly synthetic complete-source profile.
  const live = await control.createAccount({
    name: 'Hyperliquid control fixture', exchange: 'hyperliquid', mode: 'live',
    credentials: { privateKey: `0x${'a'.repeat(64)}`, walletAddress: `0x${'b'.repeat(40)}` },
  });
  await terminalHistoryAllowsCredentialRotation({ account: live, adapter: hyperliquid, engine, control, directory, entryRuntime });
  hyperliquid.candidateExternalAccountId = 'c'.repeat(64);
  await assert.rejects(control.replaceAccountCredentials({
    id: live.id,
    credentials: { privateKey: `0x${'d'.repeat(64)}`, walletAddress: `0x${'e'.repeat(40)}` },
  }), /different external exchange account/);
  hyperliquid.candidateExternalAccountId = null;
  assert.equal((await control.setAccountEnabled(live.id, false)).status, 'disabled');
  assert.equal((await control.setAccountEnabled(live.id, true)).status, 'ready');
  const removable = await control.createAccount({
    name: 'Removable Bybit', exchange: 'bybit', mode: 'testnet',
    credentials: { apiKey: 'removable-api-key', secret: 'removable-api-secret' },
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
    credentials: { apiKey: 'rejected-api-key', secret: 'rejected-api-secret' },
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
  assert.equal(entryRuntime.enabled, false, 'The kill switch must close the in-memory entry latch immediately.');
  await assert.rejects(control.setRuntime({ action: 'execution', enabled: true }), /kill switch is active/);
  let runtime = (await control.snapshot()).overview.runtime;
  assert.equal(runtime.killSwitchActive, true);
  assert.equal(runtime.executionEnabled, false);
  await control.setRuntime({ action: 'kill-switch', active: false, confirmation: 'RELEASE GLOBAL KILL SWITCH' });
  runtime = (await control.snapshot()).overview.runtime;
  assert.equal(runtime.killSwitchActive, false);
  entryRuntime.failNextEnable = true;
  await assert.rejects(
    control.setRuntime({ action: 'execution', enabled: true }),
    /simulated entry latch failure/,
  );
  assert.equal(
    (await control.snapshot()).overview.runtime.executionEnabled,
    false,
    'A failed latch enable must roll the persisted execution switch back to off.',
  );
  await control.setRuntime({ action: 'execution', enabled: true });
  assert.equal(entryRuntime.enabled, true, 'Execution must be re-enableable after safely releasing the kill switch.');

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

  const activatedWorkflow = await control.activateWorkflow({
    baseRevisionId: null,
    graph: { schemaVersion: 1, nodes: [], edges: [] },
  }, 'test:control');
  assert.equal(activatedWorkflow.createdBy, 'test:control');

  hyperliquid.remote.positions.push({ symbol: 'BTC', side: 'LONG', quantity: '1', averageEntryPrice: '60000', unrealizedPnl: '0' });
  await assert.rejects(control.assertFactoryResetSafe(), error => error instanceof AggregateError
    && error.errors.some(cause => /Unmanaged remote order or position/.test(cause.message)),
  'Foreign exposure now blocks the reset at its mandatory entry-drain proof, before any deletion.');
} finally {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}

console.log('Trading web control tests passed.');
