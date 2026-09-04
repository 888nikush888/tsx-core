import { getDatabase, initDb } from '../../src/db.js';
import { PaperExchangeAdapter } from '../../src/paper_exchange.js';
import { TradingEngine } from '../../src/trading_engine.js';

await initDb(process.argv[2]);
const timing = process.argv[4];
function parkForHardCrash() {
  process.stdout.write('EMERGENCY_CRASH_MARKER\n');
  setInterval(() => {}, 1_000);
  return new Promise(() => {});
}
if (timing === 'before') {
  const database = getDatabase();
  const originalRun = database.run.bind(database);
  database.run = async (...args) => {
    const result = await originalRun(...args);
    if (args[0].includes("UPDATE trading_orders SET status = 'submitting'") && Array.isArray(args[1])) {
      const row = await database.get('SELECT role FROM trading_orders WHERE client_order_id = ?', [args[1][2]]);
      if (row?.role === 'flatten') return parkForHardCrash();
    }
    return result;
  };
}
class CrashPaper extends PaperExchangeAdapter {
  async submitOrder(account, request) {
    const result = await super.submitOrder(account, request);
    if (request.role === 'flatten' && timing === 'after') return parkForHardCrash();
    return result;
  }
}
await new TradingEngine([new CrashPaper()]).emergencyFlattenManaged(process.argv[3]);
throw new Error('The emergency crash fixture must not complete normally.');
