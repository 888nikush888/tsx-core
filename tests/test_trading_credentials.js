import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
  await assert.rejects(
    store.set(bybitId, { exchange: 'hyperliquid', privateKey: `0x${'z'.repeat(64)}`, walletAddress: `0x${'b'.repeat(40)}` }),
    /32-byte/,
  );
  await assert.rejects(
    store.set(bybitId, { exchange: 'hyperliquid', privateKey: `0x${'a'.repeat(64)}`, walletAddress: `0x${'z'.repeat(40)}` }),
    /20-byte/,
  );
  await assert.rejects(
    store.set(bybitId, { exchange: 'bybit', apiKey: undefined, apiSecret: 'valid-secret' }),
    /API key is required/,
  );

  const promotedHyperliquidId = '33333333-3333-4333-8333-333333333333';
  const hyperliquidCandidate = await store.stageCandidate({
    exchange: 'hyperliquid', privateKey: `0x${'c'.repeat(64)}`, walletAddress: `0x${'d'.repeat(40)}`,
  });
  await store.promoteCandidate(hyperliquidCandidate, promotedHyperliquidId, 1_700_000_000_100);
  assert.deepEqual(await store.status(promotedHyperliquidId), {
    configured: true, exchange: 'hyperliquid', updatedAt: 1_700_000_000_100,
  });
  assert.equal((await store.status(hyperliquidCandidate)).configured, false);

  const promotedBybitId = '44444444-4444-4444-8444-444444444444';
  const bybitCandidate = await store.stageCandidate({
    exchange: 'bybit', apiKey: 'candidate-key', apiSecret: 'candidate-secret',
  });
  await store.promoteCandidate(bybitCandidate, promotedBybitId);
  assert.equal((await store.status(promotedBybitId)).exchange, 'bybit');
  await assert.rejects(store.promoteCandidate('invalid-candidate', promotedBybitId), /candidate identifier/);
  await assert.rejects(store.discardCandidate('invalid-candidate'), /candidate identifier/);
  const discardedCandidate = await store.stageCandidate({
    exchange: 'bybit', apiKey: 'discard-key', apiSecret: 'discard-secret',
  });
  await store.discardCandidate(discardedCandidate);
  assert.equal((await store.status(discardedCandidate)).configured, false);

  const orphanCandidate = await store.stageCandidate({
    exchange: 'bybit', apiKey: 'orphan-key', apiSecret: 'orphan-secret',
  });
  await new TradingCredentialStore(directory).initialize();
  assert.equal((await store.status(orphanCandidate)).configured, false, 'Startup must remove abandoned candidates.');

  await store.remove(bybitId);
  assert.equal((await store.status(bybitId)).configured, false);
  await store.clear();
  assert.equal((await store.status(hyperliquidId)).configured, false);
  const regenerated = await store.getOrCreateExecutorToken();
  assert.notEqual(regenerated, firstToken, 'Factory reset must rotate the internal executor token.');

  const malformedId = '55555555-5555-4555-8555-555555555555';
  const malformedPath = path.join(directory, 'trading', `${malformedId}.json`);
  await writeFile(malformedPath, 'x');
  await assert.rejects(store.status(malformedId), /small regular file/);
  await writeFile(malformedPath, JSON.stringify({ version: 2, accountId: malformedId, exchange: 'bybit' }));
  await assert.rejects(store.status(malformedId), /credential file is invalid/);
  await rm(malformedPath);

  await writeFile(path.join(directory, 'exchange_executor_token'), 'not-a-valid-token');
  await assert.rejects(store.getOrCreateExecutorToken(), /token is invalid/);
  await rm(path.join(directory, 'exchange_executor_token'));

  const unexpectedDirectory = path.join(directory, 'trading', 'unexpected-entry');
  await mkdir(unexpectedDirectory);
  await assert.rejects(store.clear(), /refused unexpected trading credential entry/);
  await rm(unexpectedDirectory, { recursive: true });
  const environmentStore = tradingCredentialStoreFromEnvironment({
    MANAGED_SECRET_DIR: path.join(directory, 'environment-secrets'),
  });
  await environmentStore.initialize();
  assert.match(await environmentStore.getOrCreateExecutorToken(), /^[a-f0-9]{64}$/);
} finally {
  await rm(directory, { recursive: true, force: true });
}

console.log('Trading credential store tests passed.');
