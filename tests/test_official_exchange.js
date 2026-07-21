import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb } from '../src/db.js';
import { OfficialExchangeAdapter } from '../src/official_exchange.js';
import { TradingCredentialStore } from '../src/trading_credentials.js';
import { createTradingAccount, ensureTradingDefaults, listTradingStrategies } from '../src/trading_repository.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'official-exchange-'));
const credentials = new TradingCredentialStore(directory);
await credentials.initialize();
const token = await credentials.getOrCreateExecutorToken();
const requests = [];
const externalAccountId = 'a'.repeat(64);
let nextResponse;
await initDb(path.join(directory, 'forwarder.db'));
await ensureTradingDefaults();

const server = http.createServer((request, response) => {
  let body = '';
  request.setEncoding('utf8');
  request.on('data', chunk => { body += chunk; });
  request.on('end', () => {
    requests.push({ url: request.url, authorization: request.headers.authorization, body });
    response.setHeader('Content-Type', 'application/json');
    if (nextResponse !== undefined) {
      const selected = nextResponse;
      nextResponse = undefined;
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
  const adapter = new OfficialExchangeAdapter('bybit', credentials);
  const account = await createTradingAccount({
    name: 'Bybit test', exchange: 'bybit', mode: 'testnet', credentialRef: 'credential-ref',
  });
  const [strategy] = await listTradingStrategies();
  await getDatabase().run(
    `INSERT INTO signals (id, chat_id, message_id, xml_content, normalized_content, created_at)
     VALUES ('official-signal', '-1', 1, '<signal/>', '<signal/>', ?)`,
    [Date.now()],
  );
  await getDatabase().run(
    `INSERT INTO trading_trade_intents (
       id, source_signal_id, channel_id, strategy_version_id, account_id, exchange, mode,
       symbol, side, status, signal_json, created_at, updated_at
     ) VALUES ('official-intent', 'official-signal', '-1', ?, ?, 'bybit', 'testnet',
               'BTCUSDT', 'LONG', 'monitoring', '{}', ?, ?)`,
    [strategy.id, account.id, Date.now(), Date.now()],
  );
  await getDatabase().run(
    `INSERT INTO trading_orders (
       id, intent_id, account_id, client_order_id, role, side, order_type, status,
       quantity, filled_quantity, reduce_only, request_json, created_at, updated_at
     ) VALUES ('official-order', 'official-intent', ?, ?, 'entry', 'buy', 'limit', 'open',
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
  }
  const submitPayload = JSON.parse(requests.find(request => request.url === '/v1/submit-order').body);
  assert.equal(submitPayload.request.maxSlippagePercent, undefined, 'The adapter must not invent a slippage value absent from the request.');
  const protectedPayload = JSON.parse(requests.find(request => request.url === '/v1/submit-protected-entry').body);
  assert.equal(protectedPayload.entry.role, 'entry');
  assert.equal(protectedPayload.protectiveStop.role, 'stop_loss');
  assert.equal(protectedPayload.protectiveStop.reduceOnly, true);

  process.env.EXCHANGE_EXECUTOR_URL = 'https://executor.invalid';
  assert.throws(() => new OfficialExchangeAdapter('bybit', credentials), /plain internal HTTP origin/);
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
      clientOrderId: 'provider-attached-stop', symbol: 'BTCUSDT', triggerPrice: '59000',
      reduceOnly: true, status: 'open',
    }],
    positions: [], fills: [], observedAt: Date.now(), accountFingerprint: externalAccountId,
  } };
  const attachedState = await adapter.openState(account);
  assert.equal(attachedState.orders[0].clientOrderId, `0x${'2'.repeat(32)}`);
  assert.equal(attachedState.orders[0].role, 'stop_loss');

  nextResponse = { status: 503, body: { error: 'executor unavailable' } };
  await assert.rejects(adapter.marketSnapshot(account, 'BTCUSDT'), /503.*executor unavailable/);
} finally {
  if (previousUrl === undefined) delete process.env.EXCHANGE_EXECUTOR_URL;
  else process.env.EXCHANGE_EXECUTOR_URL = previousUrl;
  await new Promise(resolve => server.close(resolve));
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}

console.log('Official exchange executor client tests passed.');
