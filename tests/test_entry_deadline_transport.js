import assert from 'node:assert/strict';
import { CcxtExchangeAdapter } from '../src/ccxt_exchange.ts';
import { requestFromOrder } from '../src/trading_order_request.ts';
import { TradingRiskError } from '../src/trading_risk.ts';

const realNow = Date.now;
const realFetch = globalThis.fetch;
let now = realNow();
let tokens = 0;
const sent = [];
let tokenWait = () => {};
const account = { id: 'ttl-fake', exchange: 'bybit', mode: 'testnet', externalAccountId: 'a'.repeat(64), credentialGeneration: 'b'.repeat(64) };
const credentials = { async getOrCreateExecutorToken() { tokens += 1; await tokenWait(); return 'isolated-fake-token'; } };
const adapter = new CcxtExchangeAdapter('bybit', credentials);
const leg = { role: 'entry', clientOrderId: 'ttl-entry', side: 'buy', orderType: 'limit', quantity: '1', price: '100',
  triggerPrice: null, reduceOnly: false, postOnly: false, targetIndex: null };
const plan = { symbol: 'BTCUSDT', leverage: 2, entryTimeoutSeconds: 12, maxSlippagePercent: '0.5', entryExpiresAt: now + 1000 };
const request = () => requestFromOrder(account, plan, leg);
function ack(order) {
  return { clientOrderId: order.clientOrderId, exchangeOrderId: `${order.clientOrderId}-remote`, status: 'open',
    filledQuantity: '0', averagePrice: null, error: null, raw: {} };
}
let respond = body => new Response(JSON.stringify(body.entry ? { entry: ack(body.entry), protectiveStop: ack(body.protectiveStop) } : ack(body.request)), { status: 200 });
try {
  Date.now = () => now;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    sent.push(body);
    return respond(body);
  };
  assert.equal(request().entryExpiresAt, plan.entryExpiresAt, 'The original plan deadline must enter the original journal request.');
  const stop = requestFromOrder(account, plan, { ...leg, clientOrderId: 'ttl-stop', role: 'stop_loss', reduceOnly: true });
  assert.equal(Object.hasOwn(stop, 'entryExpiresAt'), false);

  await adapter.submitProtectedEntry(account, request(), stop);
  assert.equal(sent[0].entry.entryExpiresAt, plan.entryExpiresAt);
  assert.ok(sent[0].deadlineAt <= plan.entryExpiresAt, 'Transport must not restart the absolute signal budget.');

  now = plan.entryExpiresAt;
  const beforeToken = tokens;
  await assert.rejects(adapter.submitOrder(account, request()), /ENTRY_INTENT_EXPIRED/);
  assert.equal(tokens, beforeToken, 'Expired entry must not access even the executor token.');
  assert.equal(sent.length, 1);

  now -= 100;
  tokenWait = () => { now += 200; };
  await assert.rejects(adapter.submitOrder(account, request()), /ENTRY_INTENT_EXPIRED/);
  assert.equal(sent.length, 1, 'Expiry while awaiting the token must not reach transport.');

  now = plan.entryExpiresAt - 100;
  const changed = request();
  tokenWait = () => { changed.entryExpiresAt += 30_000; };
  await assert.rejects(adapter.submitOrder(account, changed), /ENTRY_DEADLINE_CHANGED/);
  assert.equal(sent.length, 1);

  tokenWait = () => {};
  for (const entryExpiresAt of [undefined, null, true, '123', 1.5, 0, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(adapter.submitOrder(account, { ...request(), entryExpiresAt }), /ENTRY_DEADLINE_UNPROVEN/);
  }
  now = plan.entryExpiresAt + 1;
  await adapter.submitOrder(account, stop);
  assert.equal(sent.length, 2, 'Independent protection is allowed after the entry deadline.');

  now = plan.entryExpiresAt - 100;
  respond = () => {
    now += 200;
    return new Response(JSON.stringify({ code: 'ORDER_OUTCOME_UNRESOLVED', sideEffects: true, details: { confirmedOrders: [] } }), { status: 409 });
  };
  await assert.rejects(adapter.submitProtectedEntry(account, request(), stop), error => error.code === 'ORDER_OUTCOME_UNRESOLVED' && error.sideEffects === true);
  assert.equal(sent.length, 3, 'Possible send may not be retried or converted into expired absence.');
  for (const code of ['ENTRY_INTENT_EXPIRED', 'ENTRY_DEADLINE_CHANGED', 'ENTRY_DEADLINE_UNPROVEN']) {
    now = plan.entryExpiresAt - 100;
    const before = sent.length;
    respond = () => new Response(JSON.stringify({ error: 'Deadline rejected after an executor await.', code }), { status: 422 });
    await assert.rejects(adapter.submitProtectedEntry(account, request(), stop), error => {
      assert.equal(error instanceof TradingRiskError, false, 'An HTTP error code alone cannot prove that an operation was never dispatched.');
      assert.notEqual(error.sideEffects, false);
      assert.match(error.message, new RegExp(code));
      return true;
    });
    assert.equal(sent.length, before + 1, 'No submit retry on a remote deadline error.');
  }
  console.log('Entry deadline request/transport fences passed.');
} finally {
  Date.now = realNow;
  globalThis.fetch = realFetch;
}
