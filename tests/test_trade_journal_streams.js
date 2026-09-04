import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb, saveSignal } from '../src/db.js';
import {
  listTradingAccounts,
  listTradingStrategies,
  setTradingRoute,
  createTradingIntent,
} from '../src/trading_repository.js';
import { seedTradingFixtures } from './trading_fixtures.js';
import { validateSignalXml } from '../src/signal_schema.js';
import {
  listActiveExchangeStreamSymbols,
  listExchangeStreamStates,
  persistExchangeStreamBatch,
  recordExchangeStreamFailure,
} from '../src/exchange_stream_repository.js';
import {
  listTradeJournal,
  tradeJournalCsv,
  updateTradeJournalReview,
} from '../src/trade_journal.js';

const XML = `<signal>
<action>LONG</action>
<pair>BTCUSDT</pair>
<entry_range><min>60000</min><max>61000</max></entry_range>
<targets><target id="1">62000</target><target id="2">63000</target></targets>
<stoploss>59000</stoploss>
<leverage>3</leverage>
</signal>`;

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-journal-streams-'));
try {
  await initDb(path.join(directory, 'forwarder.db'));
  await seedTradingFixtures();
  const strategy = (await listTradingStrategies()).find(item => item.status === 'published');
  const paper = (await listTradingAccounts()).find(account => account.id === 'paper-default');
  await setTradingRoute({
    channelId: '-journal-channel',
    strategyVersionId: strategy.id,
    accountId: paper.id,
    enabled: true,
  });
  await saveSignal('journal-signal', '-journal-channel', 42, XML, XML);
  await getDatabase().run(
    `UPDATE signals SET template_name = 'default', schema_name = 'standard',
       prompt_sha256 = ?, model = 'test/model', provider_request_id = 'provider-42',
       parser_version = '2' WHERE id = 'journal-signal'`,
    ['a'.repeat(64)],
  );
  await getDatabase().run(
    `INSERT INTO incoming_messages (
       chat_id, message_id, sender, text, type, status, created_at
     ) VALUES ('-journal-channel', 42, 'Alice', ?, 'text', 'processed', ?)`,
    ['Call +49 170 1234567 and wallet 0x1111111111111111111111111111111111111111', Date.now()],
  );
  const executable = validateSignalXml(XML, 'default').execution;
  const intent = await createTradingIntent({
    sourceSignalId: 'journal-signal',
    channelId: '-journal-channel',
    signal: executable,
  });
  await getDatabase().run(
    `INSERT INTO trading_positions (
       id, intent_id, account_id, strategy_version_id, channel_id, symbol,
       side, status, quantity, average_entry_price, stop_price, realized_pnl,
       opened_at, closed_at, updated_at
     ) VALUES ('journal-position', ?, ?, ?, '-journal-channel', 'BTCUSDT',
               'LONG', 'closed', '0', '60000', '59000', '125.50', ?, ?, ?)`,
    [intent.id, paper.id, strategy.id, Date.now() - 10_000, Date.now(), Date.now()],
  );
  await getDatabase().run(
    `INSERT INTO trading_orders (
       id, intent_id, account_id, client_order_id, exchange_order_id, role,
       side, order_type, status, price, trigger_price, quantity,
       filled_quantity, reduce_only, request_json, response_json,
       created_at, updated_at
     ) VALUES ('journal-order', ?, ?, 'client-journal', 'exchange-journal',
               'entry', 'buy', 'limit', 'filled', '60000', NULL, '0.1',
               '0.1', 0, '{}', '{}', ?, ?)`,
    [intent.id, paper.id, Date.now() - 9_000, Date.now() - 8_000],
  );
  await getDatabase().run(
    `INSERT INTO trading_fills (
       id, order_id, account_id, exchange_fill_id, price, quantity,
       fee, fee_asset, filled_at, raw_json
      ) VALUES ('journal-fill', 'journal-order', ?, 'fill-journal',
                '60000', '0.1', '1.0000', 'USDT', ?, '{}')`,
    [paper.id, Date.now() - 8_000],
  );
  await getDatabase().run(
    `INSERT INTO trading_execution_events (
       id, intent_id, channel_id, account_id, exchange, mode,
       event_type, occurred_at, details_json
     ) VALUES ('journal-event', ?, '-journal-channel', ?, 'paper', 'paper',
               'first_fill', ?, '{}')`,
    [intent.id, paper.id, Date.now() - 8_000],
  );

  let journal = await listTradeJournal({ symbol: 'BTCUSDT' });
  assert.equal(journal.length, 1);
  assert.equal(journal[0].position.realizedPnl, null, 'A legacy position total without complete owned fill provenance is not ledger PnL.');
  assert.equal(journal[0].position.accountingStatus, 'unresolved');
  assert.equal((await getDatabase().get("SELECT realized_pnl FROM trading_positions WHERE id = 'journal-position'")).realized_pnl, '125.50',
    'The legacy amount remains available for manual review; migration must not delete or overwrite unproven evidence.');
  assert.equal(journal[0].fees.USDT, '1');
  assert.equal(journal[0].signal.schemaProfileId, 'standard');
  assert.equal(journal[0].signal.contractVersionId, 'standard:v1');
  assert.doesNotMatch(journal[0].signal.sourceExcerpt, /170 1234567|0x111111/);
  assert.match(journal[0].signal.sourceExcerpt, /MASKED_PHONE|MASKED_EVM_ADDR/);
  assert.equal((await listTradeJournal({ reviewed: false })).length, 1);

  await updateTradeJournalReview({
    intentId: intent.id,
    notes: '=HYPERLINK("https://invalid")',
    tags: ['breakout', 'reviewed'],
    rating: 4,
    reviewed: true,
  });
  journal = await listTradeJournal({ reviewed: true });
  assert.deepEqual(journal[0].review.tags, ['breakout', 'reviewed']);
  assert.equal(journal[0].review.rating, 4);
  assert.match(tradeJournalCsv(journal), /"'=HYPERLINK/);
  await assert.rejects(listTradeJournal({ symbol: 'BTCEUR' }), /USD pair/);
  await assert.rejects(listTradeJournal({ from: 20, to: 10 }), /must not be after/);
  await assert.rejects(listTradeJournal({ limit: 0 }), /limit must be between/);
  await assert.rejects(listTradeJournal({ status: 'settled' }), /status is invalid/);
  await assert.rejects(listTradeJournal({ accountId: 'bad\naccount' }), /identifier is invalid/);
  assert.equal((await listTradeJournal({
    intentId: intent.id,
    accountId: paper.id,
    channelId: '-journal-channel',
    status: journal[0].status,
    from: 0,
    to: Date.now() + 1_000,
  })).length, 1);
  await assert.rejects(updateTradeJournalReview({
    intentId: intent.id,
    notes: '',
    tags: ['x'],
    rating: 6,
    reviewed: true,
  }), /between 1 and 5/);

  await getDatabase().run(
    `INSERT INTO trading_accounts (
       id, name, exchange, mode, status, enabled, credential_ref,
       last_verified_at, last_error, created_at, updated_at
     ) VALUES ('bybit-stream', 'Bybit stream', 'bybit', 'testnet', 'ready', 1,
               'managed:bybit-stream', ?, NULL, ?, ?)`,
    [Date.now(), Date.now(), Date.now()],
  );
  const bybit = (await listTradingAccounts()).find(account => account.id === 'bybit-stream');
  const event = {
    cursor: 1,
    eventKey: 'b'.repeat(64),
    eventType: 'execution',
    symbol: 'BTCUSDT',
    sequence: 7,
    occurredAt: Date.now(),
    receivedAt: Date.now(),
    payload: { topic: 'execution', orderId: 'provider-order' },
  };
  const first = await persistExchangeStreamBatch(bybit, {
    events: [event],
    nextCursor: 1,
    gap: false,
    health: { status: 'healthy', startedAt: Date.now(), lastEventAt: Date.now(), lastError: null },
  });
  const duplicate = await persistExchangeStreamBatch(bybit, {
    events: [{ ...event, cursor: 2 }],
    nextCursor: 2,
    gap: false,
    health: { status: 'healthy', startedAt: Date.now(), lastEventAt: Date.now(), lastError: null },
  });
  assert.equal(first.inserted, 1);
  assert.equal(duplicate.inserted, 0);
  await persistExchangeStreamBatch(bybit, {
    events: [],
    nextCursor: 4,
    gap: true,
    health: { status: 'healthy', startedAt: Date.now(), lastEventAt: Date.now(), lastError: null },
  });
  let stream = (await listExchangeStreamStates()).find(item => item.accountId === bybit.id);
  assert.equal(stream.status, 'degraded');
  assert.equal(stream.gapCount, 1);
  assert.equal(
    (await getDatabase().get(
      `SELECT COUNT(*) AS count FROM trading_notification_events
       WHERE account_id = ? AND event_type = 'exchange_stream_degraded'`,
      [bybit.id],
    )).count,
    1,
    'The first stream degradation transition must emit one viewer event.',
  );
  await recordExchangeStreamFailure(bybit.id, new Error('socket offline'));
  stream = (await listExchangeStreamStates()).find(item => item.accountId === bybit.id);
  assert.match(stream.lastError, /socket offline/);
  await recordExchangeStreamFailure(bybit.id, 'plain stream failure');
  stream = (await listExchangeStreamStates()).find(item => item.accountId === bybit.id);
  assert.equal(stream.lastError, 'plain stream failure');
  await recordExchangeStreamFailure(bybit.id, { reason: 'provider disconnected' });
  stream = (await listExchangeStreamStates()).find(item => item.accountId === bybit.id);
  assert.match(stream.lastError, /provider disconnected/);
  const cyclicFailure = {};
  cyclicFailure.self = cyclicFailure;
  await recordExchangeStreamFailure(bybit.id, cyclicFailure);
  stream = (await listExchangeStreamStates()).find(item => item.accountId === bybit.id);
  assert.equal(stream.lastError, 'Unknown exchange stream error.');
  assert.equal(
    (await getDatabase().get(
      `SELECT COUNT(*) AS count FROM trading_notification_events
       WHERE account_id = ? AND event_type = 'exchange_stream_degraded'`,
      [bybit.id],
    )).count,
    1,
    'Repeated failures while already degraded must not duplicate the transition event.',
  );
  await persistExchangeStreamBatch(bybit, {
    events: [],
    nextCursor: 4,
    gap: false,
    health: { status: 'healthy', startedAt: Date.now(), lastEventAt: Date.now(), lastError: null },
  });
  assert.equal(
    (await getDatabase().get(
      `SELECT COUNT(*) AS count FROM trading_notification_events
       WHERE account_id = ? AND event_type = 'exchange_stream_recovered'`,
      [bybit.id],
    )).count,
    1,
    'A healthy state after degradation must emit one recovery event.',
  );
  const now = Date.now();
  // A quiet account can reconnect repeatedly at the same cursor. Each actual
  // transition must be delivered once, even after an executor cursor restart.
  for (const cursor of [4, 4, 0]) {
    const batch = {
      events: [], nextCursor: cursor, gap: false,
      health: { status: 'degraded', startedAt: Date.now(), lastEventAt: null, lastError: 'offline' },
    };
    await persistExchangeStreamBatch(bybit, batch);
    await persistExchangeStreamBatch(bybit, batch);
    await persistExchangeStreamBatch(bybit, { ...batch, health: { ...batch.health, status: 'healthy', lastError: null } });
  }
  for (const eventType of ['exchange_stream_degraded', 'exchange_stream_recovered']) {
    assert.equal((await getDatabase().get(
      'SELECT COUNT(*) AS count FROM trading_notification_events WHERE account_id = ? AND event_type = ?',
      [bybit.id, eventType],
    )).count, 4, 'Distinct outages at the same cursor must not suppress later notifications.');
  }
  stream = (await listExchangeStreamStates()).find(item => item.accountId === bybit.id);
  assert.equal(stream.cursor, 0, 'The displayed cursor must follow the current executor session.');
  await saveSignal('stream-pending-signal', '-journal-channel', 43, XML, XML);
  await saveSignal('stream-unknown-signal', '-journal-channel', 44, XML, XML);
  await getDatabase().run(
    `INSERT INTO trading_trade_intents (
       id, source_signal_id, root_source_signal_id, channel_id, strategy_version_id, account_id,
       exchange, mode, symbol, side, status, signal_json, plan_json,
       block_reason, last_error, created_at, updated_at
     ) VALUES
       ('stream-pending', 'stream-pending-signal', 'stream-pending-signal', '-journal-channel', ?, ?,
        'bybit', 'testnet', 'ETHUSDT', 'LONG', 'pending', '{}', NULL,
        NULL, NULL, ?, ?),
       ('stream-unknown', 'stream-unknown-signal', 'stream-unknown-signal', '-journal-channel', ?, ?,
        'bybit', 'testnet', 'HYPEPERPUSDT', 'LONG', 'unknown', '{}', NULL,
        NULL, 'provider outcome unknown', ?, ?)`,
    [strategy.id, bybit.id, now, now, strategy.id, bybit.id, now, now],
  );
  assert.deepEqual(
    await listActiveExchangeStreamSymbols(bybit.id),
    ['ETHUSDT'],
    'Unknown historical intents rely on private account events and REST; invalid public symbols must not poison the stream.',
  );
  await assert.rejects(
    persistExchangeStreamBatch(paper, {
      events: [],
      nextCursor: 0,
      gap: false,
      health: { status: 'healthy', startedAt: null, lastEventAt: null, lastError: null },
    }),
    /Paper accounts/,
  );
  console.log('Trade journal and exchange stream persistence tests passed.');
} finally {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}
