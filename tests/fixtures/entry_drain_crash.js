import { initDb } from '../../src/db.js';
import { TradingEngine } from '../../src/trading_engine.js';

await initDb(process.argv[2]);
await new TradingEngine([{ exchange: 'paper', cancelOrder: async () => {
  // The parent forcibly terminates this process only after the durable dispatch marker exists.
  process.stdout.write('CANCEL_DISPATCHED\n');
  setInterval(() => {}, 1_000);
  return new Promise(() => {});
} }]).cancelOpenEntries(process.argv[3]);
throw new Error('The crash fixture must never return normally.');
