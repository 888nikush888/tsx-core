import assert from 'node:assert/strict';
import { assertEntryModeEvidence, readEntryModeEvidence } from '../src/trading_execution_constraints.js';

const account = { id: 'mode-account', exchange: 'bybit', mode: 'testnet', externalAccountId: 'a'.repeat(64), credentialGeneration: 'b'.repeat(64),
  capabilities: { executionProfileHash: 'c'.repeat(64) } };
function evidence(overrides = {}) {
  const observedAt = Date.now();
  return { version: 1, exchange: 'bybit', symbol: 'BTCUSDT', providerSymbol: 'BTC/USDT:USDT',
    accountFingerprint: account.externalAccountId, credentialGeneration: account.credentialGeneration,
    ccxtVersion: '4.5.75', profileVersion: 1, profileHash: 'c'.repeat(64), providerApiVersion: 'bybit-v5',
    origin: 'authenticated', observedAt, expiresAt: observedAt + 10_000, entryAllowed: true, reason: null,
    positionMode: 'oneway', marginMode: 'cross', leverage: 20, leverageSemantics: 'configured',
    sources: ['v5/account/info', 'v5/position/list:symbol'], ...overrides };
}

assertEntryModeEvidence(account, 'BTCUSDT', evidence());
assert.throws(() => assertEntryModeEvidence(account, 'BTCUSDT', evidence({ entryAllowed: false, reason: 'HEDGE_MODE_UNSUPPORTED' })), /HEDGE_MODE_UNSUPPORTED/);
for (const change of [
  { entryAllowed: false, reason: 'HEDGE_MODE_UNSUPPORTED' }, { positionMode: 'hedged' }, { marginMode: 'isolated' },
  { accountFingerprint: 'd'.repeat(64) }, { credentialGeneration: 'd'.repeat(64) }, { profileHash: 'd'.repeat(64) },
  { ccxtVersion: 'unreviewed' }, { origin: 'public_bound_account' }, { symbol: 'ETHUSDT' },
  { observedAt: Date.now() - 10_001, expiresAt: Date.now() - 1 }, { observedAt: Date.now() + 1000 },
  { sources: [] }, { providerApiVersion: 'unknown' }, { leverage: null }, { leverage: 0 }, { providerSymbol: {} },
]) assert.throws(() => assertEntryModeEvidence(account, 'BTCUSDT', evidence(change)), /mode|readback|binding|evidence|profile/i);

await assert.rejects(readEntryModeEvidence({ exchange: 'bybit' }, account, 'BTCUSDT'), /mode|readback/i);
assert.equal(await readEntryModeEvidence({ exchange: 'paper' }, { exchange: 'paper' }, 'BTCUSDT'), null);
let reads = 0;
const adapter = { exchange: 'bybit', entryConstraints: async () => evidence(++reads === 1 ? {} : { marginMode: 'isolated' }) };
const first = await readEntryModeEvidence(adapter, account, 'BTCUSDT');
assert.equal(first.entryAllowed, true);
await assert.rejects(readEntryModeEvidence(adapter, account, 'BTCUSDT'), /mode/i);
assert.equal(reads, 2, 'A fresh read must observe a mode change; do not reuse preflight evidence.');
const hyperliquid = { ...account, exchange: 'hyperliquid' };
const hlEvidence = evidence({ exchange: 'hyperliquid', origin: 'public_bound_account',
  providerApiVersion: 'hyperliquid-info-exchange-v1', accountAbstraction: 'disabled' });
assertEntryModeEvidence(hyperliquid, 'BTCUSDT', hlEvidence);
for (const accountAbstraction of ['portfolioMargin', 'unifiedAccount', 'default', null, undefined]) {
  assert.throws(() => assertEntryModeEvidence(hyperliquid, 'BTCUSDT', { ...hlEvidence, accountAbstraction }), /abstraction/);
}
console.log('Entry-mode readback, profile/binding/freshness guards and changed-mode tests passed.');
