import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb, getDatabase } from '../src/db.js';
import { bindLegacyFillIdentity, unresolvedFillIdentityCount } from '../src/trading_fill_identity_repository.js';
import { seedTradingFixtures } from './trading_fixtures.js';
import { legacyFillFixture } from './fixtures/legacy_fill_identity.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'fill-contract-'));
try {
  await initDb(path.join(directory, 'test.db'));
  await seedTradingFixtures();
  const db = getDatabase();
  for (const [exchange, fields] of [['bybit', { symbol: {} }], ['hyperliquid', { coin: 7, time: '123' }],
    ['krakenfutures', { tradeable: null }]]) {
    const fixture = await legacyFillFixture(`guard-${exchange}`, exchange);
    const original = await db.get('SELECT * FROM trading_fills WHERE id=?', [fixture.fillId]);
    const raw = JSON.parse(original.raw_json);
    await db.run('UPDATE trading_fills SET raw_json=? WHERE id=?', [JSON.stringify({ ...raw, info: { ...raw.info, ...fields } }), fixture.fillId]);
    const damaged = await db.get('SELECT * FROM trading_fills WHERE id=?', [fixture.fillId]);
    assert.equal(await bindLegacyFillIdentity(fixture.account, fixture.fillId), false);
    assert.equal(await unresolvedFillIdentityCount(fixture.account), 1);
    assert.deepEqual(await db.get('SELECT * FROM trading_fills WHERE id=?', [fixture.fillId]), damaged,
      'Invalid provider metadata must never receive a synthesized binding.');
    await db.run('UPDATE trading_fills SET raw_json=? WHERE id=?', [original.raw_json, fixture.fillId]);
    const order = await db.get('SELECT exchange_order_id FROM trading_orders WHERE id=?', [fixture.orderId]);
    await db.run('UPDATE trading_orders SET exchange_order_id=NULL WHERE id=?', [fixture.orderId]);
    assert.equal(await bindLegacyFillIdentity(fixture.account, fixture.fillId), false);
    assert.equal(await unresolvedFillIdentityCount(fixture.account), 1);
    await db.run('UPDATE trading_orders SET exchange_order_id=? WHERE id=?', [order.exchange_order_id, fixture.orderId]);
    assert.equal(await bindLegacyFillIdentity(fixture.account, fixture.fillId), true,
      'Restoring complete original evidence permits the genuine historical binding.');
    assert.equal(await unresolvedFillIdentityCount(fixture.account), 0);
  }
} finally {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}
console.log('Fill identity guards retain uncertainty without changing originals until genuine evidence is restored.');
