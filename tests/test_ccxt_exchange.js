import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb } from '../src/db.js';
import { CcxtExchangeAdapter } from '../src/ccxt_exchange.js';
import { TradingSymbolUnavailableError, TradingUnresolvedOrderError } from '../src/trading_errors.js';
import { TradingCredentialStore } from '../src/trading_credentials.js';
import { createTradingAccount, getSignalContractVersion, listTradingStrategies } from '../src/trading_repository.js';
import { seedTradingFixtures } from './trading_fixtures.js';
import { exchangeRecoveryQuery } from '../src/trading_recovery.js';
import { recordAcquisitionEvidence } from '../src/trading_evidence_repository.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'official-exchange-'));
const credentials = new TradingCredentialStore(directory);
await credentials.initialize();
const token = await credentials.getOrCreateExecutorToken();
const requests = [];
const externalAccountId = 'a'.repeat(64);
const credentialGeneration = 'c'.repeat(64);
const executionProfileHash = 'd'.repeat(64);
function modeVerification() {
  return { verified: true, entryAllowed: false, reason: null, equity: '1000', externalAccountId,
    accountFingerprint: externalAccountId, credentialGeneration,
    capabilities: { profileVersion: 1, executionProfileHash, executionCapabilities: { provider_api_version: 'bybit-v5' },
      executionModeObservation: { verified: true, entryAllowed: false, requiresSymbolRead: true, reason: null,
        scope: 'account_observation', origin: 'authenticated', observedAt: Date.now(), ccxtVersion: '4.5.75' } } };
}
let nextResponse;
await initDb(path.join(directory, 'forwarder.db'));
await seedTradingFixtures();

function withAcquisition(body, recovery) {
  if (!body || !Array.isArray(body.orders) || Object.hasOwn(body, 'acquisition')) return body;
  const now = Date.now();
  return { ...body, acquisition: { version: 1, startedAt: now, completedAt: now,
    ...(recovery.readAccountMode ? { accountMode: { calls: 0, observation: null, reason: 'budget_exhausted' }, targetedCalls: 0 } : {}),
    sources: ['positions', 'orders', 'targeted_orders', 'fills'].map(source => ({ source, startedAt: now, completedAt: now,
      completeness: 'unknown', reason: 'fixture_unverified', since: null })),
    checkedOrders: recovery.orders.map(order => ({ clientOrderId: order.clientOrderId, status: 'budget_exhausted' })),
    history: recovery.history.map(checkpoint => ({ baseRevision: checkpoint.revision, pages: 0,
      checkpoint: { ...checkpoint, revision: checkpoint.revision + 1, reason: 'history_budget_exhausted' } })),
    ...(recovery.accountLogs ? { targetedCalls: 0, accountLogs: { baseRevision: recovery.accountLogs.revision, calls: 0, receipts: [],
      checkpoint: { ...recovery.accountLogs, revision: recovery.accountLogs.revision + 1, reason: 'budget_exhausted' } } } : {}),
  } };
}

async function coveredReply(account, profile) {
  const query = await exchangeRecoveryQuery(account);
  const response = withAcquisition({ orders: [], positions: [], fills: [], observedAt: Date.now(), accountFingerprint: externalAccountId }, query);
  const now = response.acquisition.completedAt;
  const source = response.acquisition.sources.find(row => row.source === 'fills');
  Object.assign(source, { completeness: 'complete', reason: null, since: query.since });
  const update = response.acquisition.history.find(row => row.checkpoint.source === 'fills');
  update.pages = 2;
  Object.assign(update.checkpoint, { providerAccountUid: account.exchange === 'krakenfutures' ? 'kraken-account' : null,
    windowSince: Math.max(query.since, now - 1000), windowUntil: null, cursor: null, scannedThrough: now,
    completeness: 'complete', reason: null, coverage: { version: 1, profile, since: query.since, through: now } });
  return response;
}

const server = http.createServer((request, response) => {
  let body = '';
  request.setEncoding('utf8');
  request.on('data', chunk => { body += chunk; });
  request.on('end', () => {
    requests.push({ url: request.url, authorization: request.headers.authorization, body, receivedAt: Date.now() });
    response.setHeader('Content-Type', 'application/json');
    if (nextResponse !== undefined) {
      const selected = nextResponse;
      nextResponse = undefined;
      if (selected.destroy === true) {
        request.socket.destroy();
        return;
      }
      response.statusCode = selected.status || 200;
      response.end(JSON.stringify(request.url === '/v1/open-state'
        ? withAcquisition(selected.body, JSON.parse(body).recovery) : selected.body));
    } else if (request.url === '/v1/account-snapshot') response.end(JSON.stringify({
      equity: '1000', availableBalance: '900', unrealizedPnl: '-2', marginUsed: '100', fundingPnlToday: null,
      accounting: { accountFingerprint: externalAccountId, reportingCurrency: 'USD', settlementAssets: ['USDT'],
        source: 'bybit-wallet-balance-v1', observedAt: Date.now(), unrealizedPnlSemantics: 'price_only',
        funding: { status: 'incomplete', since: new Date().setUTCHours(0, 0, 0, 0), until: Date.now(), source: 'durable-account-log',
          cursor: null, reason: 'persisted_observation_required', nextReadAt: 0, events: [] } },
    }));
    else if (request.url === '/v1/market-snapshot') response.end(JSON.stringify({
      symbol: 'BTCUSDT', markPrice: '60000', priceTick: '0.1', quantityStep: '0.001',
      minimumQuantity: '0.001', minimumNotional: '10', maxLeverage: 50, observedAt: Date.now(),
    }));
    else if (request.url === '/v1/verify-account') response.end(JSON.stringify(modeVerification()));
    else if (request.url === '/v1/open-state') response.end(JSON.stringify(withAcquisition({
      orders: [], positions: [], fills: [], observedAt: Date.now(), accountFingerprint: externalAccountId,
    }, JSON.parse(body).recovery)));
    else if (request.url === '/v1/cancel-order') response.end(JSON.stringify({
      clientOrderId: `0x${'1'.repeat(32)}`, exchangeOrderId: JSON.parse(body).exchangeOrderId || 'exchange-1', status: 'cancelled',
      filledQuantity: '0', averagePrice: null, error: null, raw: { cancelled: true },
    }));
    else if (request.url === '/v1/submit-protected-entry') response.end(JSON.stringify({
      entry: {
        clientOrderId: `0x${'1'.repeat(32)}`, exchangeOrderId: 'exchange-1', status: 'open',
        filledQuantity: '0', averagePrice: null, error: null, raw: { accepted: true },
      },
      protectiveStop: {
        clientOrderId: `0x${'2'.repeat(32)}`, exchangeOrderId: 'attached:exchange-1', status: 'open',
        filledQuantity: '0', averagePrice: null, error: null, raw: { providerManaged: true },
      },
    }));
    else response.end(JSON.stringify({
      clientOrderId: `0x${'1'.repeat(32)}`, exchangeOrderId: 'exchange-1', status: 'open',
      filledQuantity: '0', averagePrice: null, error: null, raw: { accepted: true },
    }));
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

const previousUrl = process.env.EXCHANGE_EXECUTOR_URL;
try {
  process.env.EXCHANGE_EXECUTOR_URL = `http://127.0.0.1:${server.address().port}`;
  const adapter = new CcxtExchangeAdapter('bybit', credentials);
  const account = await createTradingAccount({
    name: 'Bybit test', exchange: 'bybit', mode: 'testnet', credentialRef: 'credential-ref',
  });
  Object.assign(account, { externalAccountId, credentialGeneration });
  await getDatabase().run('UPDATE trading_accounts SET external_account_id=?,credential_generation=? WHERE id=?', [externalAccountId, credentialGeneration, account.id]);
  const [strategy] = await listTradingStrategies();
  assert.equal(await getSignalContractVersion('missing:v1'), null);
  await getDatabase().run(
    `INSERT INTO signals (id, chat_id, message_id, xml_content, normalized_content, created_at)
     VALUES ('official-signal', '-1', 1, '<signal/>', '<signal/>', ?)`,
    [Date.now()],
  );
  await getDatabase().run(
    `INSERT INTO trading_trade_intents (
       id, source_signal_id, root_source_signal_id, channel_id, strategy_version_id, account_id, exchange, mode,
       symbol, side, status, signal_json, created_at, updated_at
     ) VALUES ('official-intent', 'official-signal', 'official-signal', '-1', ?, ?, 'bybit', 'testnet',
               'BTCUSDT', 'LONG', 'monitoring', '{}', ?, ?)`,
    [strategy.id, account.id, Date.now(), Date.now()],
  );
  await getDatabase().run(
    `INSERT INTO trading_orders (
       id, intent_id, account_id, client_order_id, exchange_order_id, role, side, order_type, status,
       quantity, filled_quantity, reduce_only, request_json, created_at, updated_at
     ) VALUES ('official-order', 'official-intent', ?, ?, 'exchange-entry-local', 'entry', 'buy', 'limit', 'open',
                '0.01', '0', 0, '{}', ?, ?)`,
    [account.id, `0x${'1'.repeat(32)}`, Date.now(), Date.now()],
  );
  const firstBalance = await adapter.accountSnapshot(account);
  assert.equal(firstBalance.equity, '1000');
  assert.equal(firstBalance.fundingPnlToday, null, 'A balance read does not invent financial history coverage.');
  assert.equal(firstBalance.accounting.funding.observation.status, 'incomplete');
  assert.equal((await adapter.marketSnapshot(account, 'BTCUSDT')).maxLeverage, 50);
  const verified = await adapter.verifyAccount(account);
  const expectedVerification = modeVerification();
  expectedVerification.capabilities.executionModeObservation.observedAt = verified.capabilities.executionModeObservation.observedAt;
  assert.deepEqual(verified, expectedVerification);
  Object.assign(account, { capabilities: verified.capabilities });
  const result = await adapter.submitOrder(account, {
    accountId: account.id,
    symbol: 'BTCUSDT',
    clientOrderId: `0x${'1'.repeat(32)}`,
    role: 'entry', side: 'buy', orderType: 'limit', quantity: '0.01', price: '60000',
    triggerPrice: null, reduceOnly: false, postOnly: false, targetIndex: null, leverage: 3,
    entryExpiresAt: Date.now() + 60_000,
    timeoutSeconds: 7,
  });
  assert.equal(result.status, 'open');
  const protectedResult = await adapter.submitProtectedEntry(account, {
    accountId: account.id, symbol: 'BTCUSDT', clientOrderId: `0x${'1'.repeat(32)}`,
    role: 'entry', side: 'buy', orderType: 'limit', quantity: '0.01', price: '60000',
    triggerPrice: null, reduceOnly: false, postOnly: false, targetIndex: null, leverage: 3,
    entryExpiresAt: Date.now() + 60_000,
    timeoutSeconds: 7,
  }, {
    accountId: account.id, symbol: 'BTCUSDT', clientOrderId: `0x${'2'.repeat(32)}`,
    role: 'stop_loss', side: 'sell', orderType: 'stop_market', quantity: '0.01', price: null,
    triggerPrice: '59000', reduceOnly: true, postOnly: false, targetIndex: null, leverage: 3,
    timeoutSeconds: 7,
  });
  assert.equal(protectedResult.entry.status, 'open');
  assert.equal(protectedResult.protectiveStop.status, 'open');
  assert.equal((await adapter.cancelOrder(account, `0x${'1'.repeat(32)}`)).status, 'cancelled');
  const openState = await adapter.openState(account);
  assert.deepEqual(openState.orders, []);
  assert.deepEqual(openState.positions, []);
  assert.deepEqual(openState.fills, []);
  assert.ok(Number.isSafeInteger(openState.observedAt));
  assert.equal(openState.acquisition.sources.length, 4);
  const recoveryRequest = JSON.parse(requests.find(request => request.url === '/v1/open-state').body).recovery;
  assert.equal(recoveryRequest.orders[0].exchangeOrderId, 'exchange-entry-local');
  assert.equal(recoveryRequest.orders[0].symbol, 'BTCUSDT');
  assert.equal(requests.length, 7);
  for (const request of requests.filter(item => ['/v1/submit-order', '/v1/submit-protected-entry', '/v1/cancel-order'].includes(item.url))) {
    const payload = JSON.parse(request.body);
    assert.equal(payload.account.expectedAccountFingerprint, externalAccountId);
    assert.equal(payload.account.credentialGeneration, credentialGeneration);
  }
  for (const request of requests) {
    assert.equal(request.authorization, `Bearer ${token}`);
    assert.doesNotMatch(request.body, /apiSecret|privateKey|walletAddress/, 'Core-to-executor requests must never carry exchange secrets.');
    const payload = JSON.parse(request.body);
    assert.ok(payload.deadlineAt > Date.now() - 35_000, 'Every executor request must carry an end-to-end deadline.');
    if (['/v1/account-snapshot', '/v1/market-snapshot', '/v1/verify-account', '/v1/open-state'].includes(request.url)) {
      assert.ok(
        payload.deadlineAt - request.receivedAt >= 29_000,
        `${request.url} must allow a bounded cold CCXT market bootstrap.`,
      );
    }
  }

  nextResponse = { body: { verified: true, equity: '1000', externalAccountId, accountFingerprint: externalAccountId, credentialGeneration } };
  await assert.rejects(adapter.verifyAccount(account), /mode observation/i, 'An older executor without actual mode observation must not verify.');
  const staleVerification = modeVerification();
  staleVerification.capabilities.executionModeObservation.observedAt -= 10_001;
  nextResponse = { body: staleVerification };
  await assert.rejects(adapter.verifyAccount(account), /mode observation is stale/);
  const modeObservedAt = Date.now();
  const modeEvidence = { version: 1, exchange: 'bybit', symbol: 'BTCUSDT', providerSymbol: 'BTC/USDT:USDT',
    accountFingerprint: externalAccountId, credentialGeneration, ccxtVersion: '4.5.75', profileVersion: 1,
    profileHash: executionProfileHash, providerApiVersion: 'bybit-v5', origin: 'authenticated',
    observedAt: modeObservedAt, expiresAt: modeObservedAt + 10_000, entryAllowed: true, reason: null,
    positionMode: 'oneway', marginMode: 'cross', leverage: 20, leverageSemantics: 'configured', sources: ['v5/account/info', 'v5/position/list:symbol'] };
  nextResponse = { body: modeEvidence };
  assert.deepEqual(await adapter.entryConstraints(account, 'BTCUSDT'), modeEvidence);
  const modeRequest = JSON.parse(requests.at(-1).body);
  assert.equal(requests.at(-1).url, '/v1/entry-constraints');
  assert.equal(modeRequest.account.expectedAccountFingerprint, externalAccountId);
  assert.equal(modeRequest.account.credentialGeneration, credentialGeneration);
  assert.equal(modeRequest.symbol, 'BTCUSDT');
  nextResponse = { body: { ...modeEvidence, entryAllowed: false, reason: 'HEDGE_MODE_UNSUPPORTED' } };
  await assert.rejects(adapter.entryConstraints(account, 'BTCUSDT'), /HEDGE_MODE_UNSUPPORTED/);

  nextResponse = { body: { orders: [], positions: [], fills: [], observedAt: Date.now(), accountFingerprint: externalAccountId, acquisition: null } };
  await assert.rejects(adapter.openState(account), /omitted acquisition/);
  nextResponse = { body: withAcquisition({ orders: [], positions: [], fills: [], observedAt: Date.now(), accountFingerprint: externalAccountId },
    { orders: [{ clientOrderId: 'not-requested' }], history: JSON.parse(requests.at(-1).body).recovery.history }) };
  await assert.rejects(adapter.openState(account), /recovery scope/);

  const writeRequest = {
    accountId: account.id, symbol: 'BTCUSDT', clientOrderId: 'partial-entry',
    entryExpiresAt: Date.now() + 60_000,
    role: 'entry', side: 'buy', orderType: 'limit', quantity: '0.01', price: '60000',
    triggerPrice: null, reduceOnly: false, postOnly: false, targetIndex: null, leverage: 3,
    timeoutSeconds: 7,
  };
  const writeStop = { ...writeRequest, clientOrderId: 'partial-stop', role: 'stop_loss', reduceOnly: true };
  const confirmedLeg = {
    clientOrderId: 'partial-entry', exchangeOrderId: 'real-partial-entry', status: 'open',
    filledQuantity: '0', averagePrice: null, error: null, raw: {},
  };
  const beforeUnbound = requests.length;
  await assert.rejects(() => adapter.submitOrder({ ...account, credentialGeneration: null }, writeRequest), /identity binding/i);
  assert.equal(requests.length, beforeUnbound, 'Unbound writes never reach the executor.');
  nextResponse = { status: 409, body: {
    code: 'ORDER_OUTCOME_UNRESOLVED', sideEffects: true,
    details: { confirmedOrders: [confirmedLeg], unresolvedClientOrderIds: ['partial-stop'] },
  } };
  await assert.rejects(() => adapter.submitProtectedEntry(account, writeRequest, writeStop), error => {
    assert.ok(error instanceof TradingUnresolvedOrderError);
    assert.deepEqual(error.confirmedOrders, [confirmedLeg]);
    return true;
  });
  assert.equal(requests.length, beforeUnbound + 1, 'Ambiguous write is never retried.');
  const submitPayload = JSON.parse(requests.find(request => request.url === '/v1/submit-order').body);
  assert.equal(submitPayload.request.maxSlippagePercent, undefined, 'The adapter must not invent a slippage value absent from the request.');
  const protectedPayload = JSON.parse(requests.find(request => request.url === '/v1/submit-protected-entry').body);
  assert.equal(protectedPayload.entry.role, 'entry');
  assert.equal(protectedPayload.protectiveStop.role, 'stop_loss');
  assert.equal(protectedPayload.protectiveStop.reduceOnly, true);

  const streamNow = Date.now();
  nextResponse = { body: {
    events: [{
      cursor: 1,
      eventKey: 'd'.repeat(64),
      eventType: 'execution',
      symbol: 'BTCUSDT',
      sequence: 7,
      occurredAt: streamNow,
      receivedAt: streamNow,
      payload: { orderId: 'stream-order' },
    }],
    nextCursor: 1,
    gap: false,
    health: { status: 'healthy', startedAt: streamNow, lastEventAt: streamNow, lastError: null },
  } };
  const stream = await adapter.streamEvents(account, 0, ['BTCUSDT', 'BTCUSDT']);
  assert.equal(stream.events[0].eventType, 'execution');
  const streamRequest = JSON.parse(requests.at(-1).body);
  assert.deepEqual(streamRequest.symbols, ['BTCUSDT'], 'Stream symbols must be deduplicated and sorted.');
  assert.ok(
    streamRequest.deadlineAt - requests.at(-1).receivedAt >= 29_000,
    'The first CCXT Pro stream poll must allow a bounded cold market bootstrap.',
  );
  await assert.rejects(adapter.streamEvents(account, -1, []), /cursor is invalid/);
  await assert.rejects(adapter.streamEvents(account, 0, ['BTCEUR']), /bounded USD pairs/);

  nextResponse = { body: { events: {}, nextCursor: 0, gap: false, health: {} } };
  await assert.rejects(adapter.streamEvents(account, 0, []), /invalid stream batch contract/);
  nextResponse = { body: {
    events: [], nextCursor: 0, gap: false,
    health: { status: 'unknown', startedAt: null, lastEventAt: null, lastError: null },
  } };
  await assert.rejects(adapter.streamEvents(account, 0, []), /invalid stream health/);
  nextResponse = { body: {
    events: [{
      cursor: 0, eventKey: 'bad', eventType: 'other', symbol: 'TOO-LONG', sequence: {},
      occurredAt: -1, receivedAt: -1, payload: null,
    }],
    nextCursor: 1,
    gap: true,
    health: { status: 'degraded', startedAt: null, lastEventAt: null, lastError: 'gap' },
  } };
  await assert.rejects(adapter.streamEvents(account, 0, []), /invalid stream event/);

  process.env.EXCHANGE_EXECUTOR_URL = 'https://executor.invalid';
  assert.throws(() => new CcxtExchangeAdapter('bybit', credentials), /plain internal HTTP origin/);
  process.env.EXCHANGE_EXECUTOR_URL = 'http://public.example:8090';
  assert.throws(
    () => new CcxtExchangeAdapter('bybit', credentials),
    /internal executor host/,
    'Executor order and account requests must not send their bearer token to an external HTTP host.',
  );
  process.env.EXCHANGE_EXECUTOR_URL = `http://127.0.0.1:${server.address().port}`;

  nextResponse = { body: {
    clientOrderId: 'wrong-request-id', exchangeOrderId: 'remote-wrong', status: 'open',
    filledQuantity: '0', averagePrice: null, error: null, raw: {},
  } };
  await assert.rejects(
    adapter.submitOrder(account, { ...writeRequest, clientOrderId: 'expected-request-id', quantity: '1' }),
    /identifier.*match/i,
    'A structurally valid response for another request must never be accepted.',
  );

  nextResponse = { body: null };
  await assert.rejects(adapter.submitOrder(account, writeRequest), /invalid contract/);
  nextResponse = { body: { status: 'open', exchangeOrderId: 'exchange-1' } };
  await assert.rejects(adapter.submitOrder(account, writeRequest), /identifier/i);
  nextResponse = { body: { clientOrderId: 'client-1', exchangeOrderId: 'exchange-1', status: 'impossible' } };
  await assert.rejects(adapter.submitOrder(account, { ...writeRequest, clientOrderId: 'client-1' }), /invalid.*order status/i);
  nextResponse = { body: { verified: false, equity: '1000', externalAccountId, accountFingerprint: externalAccountId } };
  await assert.rejects(adapter.verifyAccount(account), /invalid verified-account identity/);
  nextResponse = { body: { equity: '1000', availableBalance: '900', unrealizedPnl: '0', marginUsed: '0' } };
  await assert.rejects(adapter.accountSnapshot(account), /omitted fundingPnlToday/);
  const accountingTime = Date.now();
  const unknownAccounting = { accountFingerprint: externalAccountId, reportingCurrency: 'USD', settlementAssets: ['USDT'],
    source: 'bybit-wallet-balance-v1', observedAt: accountingTime, unrealizedPnlSemantics: 'price_only',
    funding: { status: 'incomplete', since: new Date(accountingTime).setUTCHours(0, 0, 0, 0), until: accountingTime,
      cursor: 'next-page', source: 'bybit:funding-v1', reason: 'budget_exhausted', nextReadAt: 0, events: [] } };
  const unknownFundingSnapshot = { equity: '1000', availableBalance: '900', unrealizedPnl: '0', marginUsed: '0',
    fundingPnlToday: null, accounting: unknownAccounting };
  nextResponse = { body: unknownFundingSnapshot };
  const receivedUnknown = await adapter.accountSnapshot(account);
  assert.equal(receivedUnknown.fundingPnlToday, null, 'Unknown funding must cross the HTTP boundary unchanged.');
  assert.equal(receivedUnknown.accounting.funding.cursor, null, 'The transient balance-response cursor is not a durable producer checkpoint.');
  assert.equal(receivedUnknown.accounting.funding.observation.status, 'incomplete');
  nextResponse = { body: { ...unknownFundingSnapshot, fundingPnlToday: '0' } };
  await assert.rejects(adapter.accountSnapshot(account), /contradicts/);
  nextResponse = { body: { ...unknownFundingSnapshot, accounting: { ...unknownAccounting, accountFingerprint: 'b'.repeat(64) } } };
  await assert.rejects(adapter.accountSnapshot(account), /fingerprint/);
  await assert.rejects(adapter.cancelOrder(account, 'unknown-local-order'), /without a local symbol mapping/);
  nextResponse = { body: { orders: {}, positions: [], fills: [], accountFingerprint: externalAccountId } };
  await assert.rejects(adapter.openState(account), /invalid open-state contract/);
  nextResponse = { body: { orders: [], positions: [], fills: [], accountFingerprint: 'invalid' } };
  await assert.rejects(adapter.openState(account), /invalid account fingerprint/);

  await getDatabase().run(
    `INSERT INTO trading_orders (
       id, intent_id, account_id, client_order_id, role, side, order_type, status,
       quantity, filled_quantity, reduce_only, trigger_price, request_json, created_at, updated_at
     ) VALUES ('official-stop', 'official-intent', ?, ?, 'stop_loss', 'sell', 'stop_market', 'open',
               '0.01', '0', 1, '59000', '{}', ?, ?)`,
    [account.id, `0x${'2'.repeat(32)}`, Date.now(), Date.now()],
  );
  nextResponse = { body: {
    orders: [{
      clientOrderId: null, exchangeOrderId: 'provider-attached-stop', symbol: 'BTCUSDT',
      providerSymbol: 'BTC/USDT:USDT',
      triggerPrice: '59000', reduceOnly: true, side: 'sell', quantity: '0.010', status: 'open',
      filledQuantity: '0', averagePrice: null, error: null, price: null, role: 'stop_loss', raw: {},
    }],
    positions: [], fills: [{
      exchangeFillId: 'fill-without-client-id', clientOrderId: null,
      exchangeOrderId: 'exchange-entry-local', price: '60000', quantity: '0.01',
      symbol: 'BTCUSDT', providerSymbol: 'BTC/USDT:USDT',
      fee: '1', feeAsset: 'USDT', filledAt: Date.now(), raw: {},
    }], observedAt: Date.now(), accountFingerprint: externalAccountId,
  } };
  const attachedState = await adapter.openState(account);
  assert.equal(attachedState.orders[0].clientOrderId, null, 'A price/quantity-similar stop is not proof of ownership.');
  assert.equal(attachedState.orders[0].role, 'stop_loss');
  assert.equal(attachedState.fills[0].clientOrderId, `0x${'1'.repeat(32)}`);
  await getDatabase().run(
    "UPDATE trading_orders SET exchange_order_id = 'provider-attached-stop', provider_symbol = 'BTC/USDT:USDT' WHERE id = 'official-stop'",
  );
  nextResponse = { body: attachedState };
  assert.equal((await adapter.openState(account)).orders[0].clientOrderId, `0x${'2'.repeat(32)}`, 'An exact scoped exchange-ID binding recovers a missing client ID.');

  await getDatabase().run(
    `INSERT INTO trading_orders (
       id, intent_id, account_id, client_order_id, role, side, order_type, status,
       quantity, filled_quantity, reduce_only, trigger_price, request_json, created_at, updated_at
     ) VALUES ('ambiguous-stop', 'official-intent', ?, ?, 'stop_loss', 'sell', 'stop_market', 'open',
               '0.01', '0', 1, '59000', '{}', ?, ?)`,
    [account.id, `0x${'3'.repeat(32)}`, Date.now(), Date.now()],
  );
  nextResponse = { body: {
    orders: [{
      clientOrderId: null, exchangeOrderId: 'provider-ambiguous-stop', symbol: 'BTCUSDT',
      triggerPrice: '59000', reduceOnly: true, side: 'sell', quantity: '0.01', status: 'open',
      filledQuantity: '0', averagePrice: null, error: null, price: null, role: 'stop_loss', raw: {},
    }],
    positions: [], fills: [], observedAt: Date.now(), accountFingerprint: externalAccountId,
  } };
  const ambiguousState = await adapter.openState(account);
  assert.equal(ambiguousState.orders[0].clientOrderId, null, 'Ambiguous attached stops must remain unmanaged.');

  const readsBeforeRetry = requests.length;
  nextResponse = { status: 503, body: { error: 'executor unavailable', code: 'MARKET_SNAPSHOT_FAILED' } };
  assert.equal(
    (await adapter.marketSnapshot(account, 'BTCUSDT')).symbol,
    'BTCUSDT',
    'Read-only executor requests must retry a bounded transient 503 response.',
  );
  assert.equal(requests.length - readsBeforeRetry, 2);

  const readsBeforeIncompleteRetry = requests.length;
  nextResponse = { status: 503, body: { error: 'Current account snapshot is incomplete.', code: 'CURRENT_STATE_INCOMPLETE',
    sideEffects: false, details: { source: 'orders', reason: 'current_page_budget_exhausted' } } };
  await assert.rejects(adapter.openState(account), /CURRENT_STATE_INCOMPLETE/);
  assert.equal(requests.length - readsBeforeIncompleteRetry, 1, 'A budgeted history request never starts a second five-call pool after an uncertain response.');
  await adapter.openState(account);
  assert.equal(requests.length - readsBeforeIncompleteRetry, 2, 'The next explicit recovery resumes the same durable checkpoint.');
  assert.ok(requests.slice(readsBeforeIncompleteRetry).every(request => request.url === '/v1/open-state'));

  const readsBeforeTransportRetry = requests.length;
  nextResponse = { destroy: true };
  assert.equal(
    (await adapter.accountSnapshot(account)).equity,
    '1000',
    'Read-only executor requests must retry one bounded transport failure.',
  );
  assert.equal(requests.length - readsBeforeTransportRetry, 2);

  const readsBeforeSymbolMiss = requests.length;
  nextResponse = {
    status: 422,
    body: {
      error: 'Symbol SOLUSDT is unavailable on the certified linear perpetual market.',
      code: 'SYMBOL_UNAVAILABLE',
      sideEffects: false,
      details: { exchange: 'bybit', accountId: account.id, symbol: 'SOLUSDT' },
    },
  };
  await assert.rejects(
    adapter.marketSnapshot(account, 'SOLUSDT'),
    error => error instanceof TradingSymbolUnavailableError
      && error.code === 'SYMBOL_UNAVAILABLE'
      && error.sideEffects === false
      && error.details.symbol === 'SOLUSDT',
  );
  assert.equal(requests.length - readsBeforeSymbolMiss, 1, 'A typed symbol miss is deterministic and must not be retried.');

  nextResponse = {
    status: 422,
    body: { error: 'unsafe malformed response', code: 'SYMBOL_UNAVAILABLE', sideEffects: true },
  };
  await assert.rejects(
    adapter.marketSnapshot(account, 'SOLUSDT'),
    /422.*unsafe malformed response.*SYMBOL_UNAVAILABLE/,
    'Fallback requires the explicit sideEffects=false contract.',
  );

  nextResponse = {
    status: 422,
    body: {
      error: 'typed code returned from an unsafe mutation endpoint',
      code: 'SYMBOL_UNAVAILABLE',
      sideEffects: false,
      details: { exchange: 'bybit', accountId: account.id, symbol: 'BTCUSDT' },
    },
  };
  await assert.rejects(
    adapter.submitOrder(account, writeRequest),
    error => !(error instanceof TradingSymbolUnavailableError)
      && /422.*unsafe mutation endpoint.*SYMBOL_UNAVAILABLE/.test(error.message),
    'Only the read-only market-snapshot endpoint may activate account fallback.',
  );

  nextResponse = {
    status: 422,
    body: {
      error: 'typed code with mismatched identity',
      code: 'SYMBOL_UNAVAILABLE',
      sideEffects: false,
      details: { exchange: 'bybit', accountId: 'different-account', symbol: 'SOLUSDT' },
    },
  };
  await assert.rejects(
    adapter.marketSnapshot(account, 'SOLUSDT'),
    error => !(error instanceof TradingSymbolUnavailableError)
      && /422.*mismatched identity.*SYMBOL_UNAVAILABLE/.test(error.message),
    'The typed fallback response must match the requested account and symbol exactly.',
  );

  const mutationsBeforeFailure = requests.length;
  nextResponse = { status: 503, body: { error: 'executor unavailable', code: 'ORDER_SUBMIT_FAILED' } };
  await assert.rejects(
    adapter.submitOrder(account, writeRequest),
    /503.*executor unavailable.*ORDER_SUBMIT_FAILED/,
  );
  assert.equal(
    requests.length - mutationsBeforeFailure,
    1,
    'Mutating order requests must not be retried after an uncertain transport outcome.',
  );
  for (const [exchange, profile] of [['hyperliquid', 'hyperliquid_retained_fills_v1'], ['krakenfutures', 'kraken_v3_executions_v1']]) {
    const coverageAccount = await createTradingAccount({ name: `${exchange} coverage`, exchange, mode: 'testnet', credentialRef: 'fixture-only' });
    Object.assign(coverageAccount, { externalAccountId, credentialGeneration });
    await getDatabase().run('UPDATE trading_accounts SET external_account_id=?,credential_generation=? WHERE id=?', [externalAccountId, credentialGeneration, coverageAccount.id]);
    const reader = new CcxtExchangeAdapter(exchange, credentials);
    const body = await coveredReply(coverageAccount, profile);
    nextResponse = { body };
    const observed = await reader.openState(coverageAccount);
    assert.equal(observed.acquisition.sources.find(row => row.source === 'fills').completeness, 'complete');
    const beforeIngestion = await exchangeRecoveryQuery(coverageAccount);
    assert.equal(beforeIngestion.history.find(row => row.source === 'fills').coverage, null, 'An HTTP success alone cannot checkpoint ingestion.');
    await recordAcquisitionEvidence(coverageAccount, observed.acquisition);
    const ingested = await exchangeRecoveryQuery(coverageAccount);
    assert.deepEqual(ingested.history.find(row => row.source === 'fills').coverage,
      observed.acquisition.history.find(row => row.checkpoint.source === 'fills').checkpoint.coverage);
    const replay = await coveredReply(coverageAccount, profile);
    replay.acquisition.history.find(row => row.checkpoint.source === 'fills').pages = 0;
    nextResponse = { body: replay };
    await assert.rejects(reader.openState(coverageAccount), /unread|NOT_FRESH/);
  }
  nextResponse = { body: await coveredReply(account, 'bybit_v5_linear_endpoint_v1') };
  await assert.rejects(adapter.openState(account), /FILL_OPTION_SCOPE_UNPROVED/,
    'A linear Bybit endpoint cannot certify all option and pre-upgrade activity.');
} finally {
  if (previousUrl === undefined) delete process.env.EXCHANGE_EXECUTOR_URL;
  else process.env.EXCHANGE_EXECUTOR_URL = previousUrl;
  await new Promise(resolve => server.close(resolve));
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}

console.log('CCXT exchange executor client tests passed.');
