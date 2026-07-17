import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TradingCredentialStore, tradingCredentialStoreFromEnvironment } from '../src/trading_credentials.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'trading-credentials-'));
try {
  const store = new TradingCredentialStore(directory);
  await store.initialize();
  const firstToken = await store.getOrCreateExecutorToken();
  assert.match(firstToken, /^[a-f0-9]{64}$/);
  assert.equal(await store.getOrCreateExecutorToken(), firstToken, 'Internal token must survive restart.');

  const hyperliquidId = '11111111-1111-4111-8111-111111111111';
  await store.set(hyperliquidId, {
    exchange: 'hyperliquid',
    privateKey: `0x${'a'.repeat(64)}`,
    walletAddress: `0x${'b'.repeat(40)}`,
  }, 1_700_000_000_000);
  assert.deepEqual(await store.status(hyperliquidId), {
    configured: true,
    exchange: 'hyperliquid',
    updatedAt: 1_700_000_000_000,
  });
  const credentialFile = path.join(directory, 'trading', `${hyperliquidId}.json`);
  assert.equal((await stat(credentialFile)).isFile(), true);
  assert.match(await readFile(credentialFile, 'utf8'), /"privateKey"/);

  const bybitId = '22222222-2222-4222-8222-222222222222';
  await store.set(bybitId, { exchange: 'bybit', apiKey: 'bybit-key-123', apiSecret: 'bybit-secret-123' });
  assert.equal((await store.status(bybitId)).configured, true);
  await assert.rejects(
    store.set('invalid/account', { exchange: 'bybit', apiKey: 'valid-key', apiSecret: 'valid-secret' }),
    /Invalid trading account identifier/,
  );
  await assert.rejects(
    store.set(bybitId, { exchange: 'hyperliquid', privateKey: 'bad', walletAddress: 'bad' }),
    /private key/,
  );

  await store.remove(bybitId);
  assert.equal((await store.status(bybitId)).configured, false);
  await store.clear();
  assert.equal((await store.status(hyperliquidId)).configured, false);
  const regenerated = await store.getOrCreateExecutorToken();
  assert.notEqual(regenerated, firstToken, 'Factory reset must rotate the internal executor token.');
  const environmentStore = tradingCredentialStoreFromEnvironment({
    MANAGED_SECRET_DIR: path.join(directory, 'environment-secrets'),
  });
  await environmentStore.initialize();
  assert.match(await environmentStore.getOrCreateExecutorToken(), /^[a-f0-9]{64}$/);
} finally {
  await rm(directory, { recursive: true, force: true });
}

console.log('Trading credential store tests passed.');
