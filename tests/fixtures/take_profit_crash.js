import { getDatabase, initDb } from '../../src/db.js';
import { PaperExchangeAdapter } from '../../src/paper_exchange.js';
import { TradingEngine } from '../../src/trading_engine.js';

await initDb(process.argv[2]);
const timing = process.argv[4];
function park() {
  process.stdout.write('TP_CRASH_MARKER\n');
  setInterval(() => {}, 1_000);
  return new Promise(() => {});
}
if (timing !== 'accepted') {
  const database = getDatabase();
  const run = database.run.bind(database);
  database.run = async (...args) => {
    const marking = args[0].includes("UPDATE trading_orders SET status = 'submitting'") && Array.isArray(args[1]);
    const row = marking ? await database.get('SELECT role FROM trading_orders WHERE client_order_id = ?', [args[1][2]]) : null;
    if (row?.role === 'take_profit' && timing === 'created') return park();
    const result = await run(...args);
    if (row?.role === 'take_profit' && timing === 'prepared') return park();
    return result;
  };
}
class CrashPaper extends PaperExchangeAdapter {
  async submitOrder(account, request) {
    const result = await super.submitOrder(account, request);
    if (request.role === 'take_profit' && timing === 'accepted') return park();
    return result;
  }
}
await new TradingEngine([new CrashPaper()]).reconcileAccount(process.argv[3]);
throw new Error('The TP crash fixture must not complete normally.');
