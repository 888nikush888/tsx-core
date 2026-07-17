import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OfficialExchangeAdapter } from '../src/official_exchange.js';
import { TradingCredentialStore } from '../src/trading_credentials.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'official-exchange-'));
const credentials = new TradingCredentialStore(directory);
await credentials.initialize();
const token = await credentials.getOrCreateExecutorToken();
const requests = [];

const server = http.createServer((request, response) => {
  let body = '';
  request.setEncoding('utf8');
  request.on('data', chunk => { body += chunk; });
  request.on('end', () => {
    requests.push({ url: request.url, authorization: request.headers.authorization, body });
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/v1/account-snapshot') response.end(JSON.stringify({ equity: '1000', availableBalance: '900' }));
    else if (request.url === '/v1/market-snapshot') response.end(JSON.stringify({
      symbol: 'BTCUSDT', markPrice: '60000', priceTick: '0.1', quantityStep: '0.001',
      minimumQuantity: '0.001', minimumNotional: '10', maxLeverage: 50, observedAt: Date.now(),
    }));
    else if (request.url === '/v1/verify-account') response.end(JSON.stringify({ verified: true, equity: '1000' }));
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
  const account = {
    id: '11111111-1111-4111-8111-111111111111', name: 'Bybit test', exchange: 'bybit', mode: 'testnet',
    status: 'ready', enabled: true, credentialRef: 'credential-ref', lastVerifiedAt: null,
    lastError: null, createdAt: 1, updatedAt: 1,
  };
  assert.deepEqual(await adapter.accountSnapshot(account), { equity: '1000', availableBalance: '900' });
  assert.equal((await adapter.marketSnapshot(account, 'BTCUSDT')).maxLeverage, 50);
  assert.equal((await adapter.verifyAccount(account)).verified, true);
  const result = await adapter.submitOrder(account, {
    accountId: account.id,
    symbol: 'BTCUSDT',
    clientOrderId: `0x${'1'.repeat(32)}`,
    role: 'entry', side: 'buy', orderType: 'limit', quantity: '0.01', price: '60000',
    triggerPrice: null, reduceOnly: false, postOnly: false, targetIndex: null, leverage: 3,
  });
  assert.equal(result.status, 'open');
  assert.equal(requests.length, 4);
  for (const request of requests) {
    assert.equal(request.authorization, `Bearer ${token}`);
    assert.doesNotMatch(request.body, /apiSecret|privateKey|walletAddress/, 'Core-to-executor requests must never carry exchange secrets.');
  }
} finally {
  if (previousUrl === undefined) delete process.env.EXCHANGE_EXECUTOR_URL;
  else process.env.EXCHANGE_EXECUTOR_URL = previousUrl;
  await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}

console.log('Official exchange executor client tests passed.');
