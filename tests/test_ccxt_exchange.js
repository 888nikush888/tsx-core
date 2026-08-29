import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb } from '../src/db.js';
import { CcxtExchangeAdapter } from '../src/ccxt_exchange.js';
import { TradingSymbolUnavailableError } from '../src/trading_errors.js';
import { TradingCredentialStore } from '../src/trading_credentials.js';
import { createTradingAccount, getSignalContractVersion, listTradingStrategies } from '../src/trading_repository.js';
import { seedTradingFixtures } from './trading_fixtures.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'official-exchange-'));
const credentials = new TradingCredentialStore(directory);
await credentials.initialize();
const token = await credentials.getOrCreateExecutorToken();
const requests = [];
const externalAccountId = 'a'.repeat(64);
let nextResponse;
await initDb(path.join(directory, 'forwarder.db'));
await seedTradingFixtures();

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
      response.end(JSON.stringify(selected.body));
    } else if (request.url === '/v1/account-snapshot') response.end(JSON.stringify({
      equity: '1000', availableBalance: '900', unrealizedPnl: '-2', marginUsed: '100', fundingPnlToday: '-1',
    }));
    else if (request.url === '/v1/market-snapshot') response.end(JSON.stringify({
      symbol: 'BTCUSDT', markPrice: '60000', priceTick: '0.1', quantityStep: '0.001',
      minimumQuantity: '0.001', minimumNotional: '10', maxLeverage: 50, observedAt: Date.now(),
    }));
    else if (request.url === '/v1/verify-account') response.end(JSON.stringify({
      verified: true, equity: '1000', externalAccountId, accountFingerprint: externalAccountId,
    }));
    else if (request.url === '/v1/open-state') response.end(JSON.stringify({
      orders: [], positions: [], fills: [], observedAt: Date.now(), accountFingerprint: externalAccountId,
    }));
    else if (request.url === '/v1/cancel-order') response.end(JSON.stringify({
      clientOrderId: `0x${'1'.repeat(32)}`, exchangeOrderId: 'exchange-1', status: 'cancelled',
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
  assert.deepEqual(await adapter.accountSnapshot(account), {
    equity: '1000', availableBalance: '900', unrealizedPnl: '-2', marginUsed: '100', fundingPnlToday: '-1',
  });
  assert.equal((await adapter.marketSnapshot(account, 'BTCUSDT')).maxLeverage, 50);
  assert.deepEqual(await adapter.verifyAccount(account), {
    verified: true, equity: '1000', externalAccountId, accountFingerprint: externalAccountId,
  });
  const result = await adapter.submitOrder(account, {
    accountId: account.id,
    symbol: 'BTCUSDT',
    clientOrderId: `0x${'1'.repeat(32)}`,
    role: 'entry', side: 'buy', orderType: 'limit', quantity: '0.01', price: '60000',
    triggerPrice: null, reduceOnly: false, postOnly: false, targetIndex: null, leverage: 3,
    timeoutSeconds: 7,
  });
  assert.equal(result.status, 'open');
  const protectedResult = await adapter.submitProtectedEntry(account, {
    accountId: account.id, symbol: 'BTCUSDT', clientOrderId: `0x${'1'.repeat(32)}`,
    role: 'entry', side: 'buy', orderType: 'limit', quantity: '0.01', price: '60000',
    triggerPrice: null, reduceOnly: false, postOnly: false, targetIndex: null, leverage: 3,
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
  assert.equal(requests.length, 7);
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

  nextResponse = { body: null };
  await assert.rejects(adapter.submitOrder(account, { symbol: 'BTCUSDT' }), /invalid contract/);
  nextResponse = { body: { status: 'open', exchangeOrderId: 'exchange-1' } };
  await assert.rejects(adapter.submitOrder(account, { symbol: 'BTCUSDT' }), /invalid order identifier/);
  nextResponse = { body: { clientOrderId: 'client-1', exchangeOrderId: 'exchange-1', status: 'impossible' } };
  await assert.rejects(adapter.submitOrder(account, { symbol: 'BTCUSDT' }), /invalid order status/);
  nextResponse = { body: { verified: false, equity: '1000', externalAccountId, accountFingerprint: externalAccountId } };
  await assert.rejects(adapter.verifyAccount(account), /invalid verified-account identity/);
  nextResponse = { body: { equity: '1000', availableBalance: '900', unrealizedPnl: '0', marginUsed: '0' } };
  await assert.rejects(adapter.accountSnapshot(account), /omitted fundingPnlToday/);
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
      triggerPrice: '59000', reduceOnly: true, side: 'sell', quantity: '0.010', status: 'open',
    }],
    positions: [], fills: [{
      exchangeFillId: 'fill-without-client-id', clientOrderId: null,
      exchangeOrderId: 'exchange-entry-local', price: '60000', quantity: '0.01',
      fee: '1', feeAsset: 'USDT', filledAt: Date.now(), raw: {},
    }], observedAt: Date.now(), accountFingerprint: externalAccountId,
  } };
  const attachedState = await adapter.openState(account);
  assert.equal(attachedState.orders[0].clientOrderId, `0x${'2'.repeat(32)}`);
  assert.equal(attachedState.orders[0].role, 'stop_loss');
  assert.equal(attachedState.fills[0].clientOrderId, `0x${'1'.repeat(32)}`);

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
    adapter.submitOrder(account, { symbol: 'BTCUSDT' }),
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
    adapter.submitOrder(account, { symbol: 'BTCUSDT' }),
    /503.*executor unavailable.*ORDER_SUBMIT_FAILED/,
  );
  assert.equal(
    requests.length - mutationsBeforeFailure,
    1,
    'Mutating order requests must not be retried after an uncertain transport outcome.',
  );
} finally {
  if (previousUrl === undefined) delete process.env.EXCHANGE_EXECUTOR_URL;
  else process.env.EXCHANGE_EXECUTOR_URL = previousUrl;
  await new Promise(resolve => server.close(resolve));
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}

console.log('CCXT exchange executor client tests passed.');
