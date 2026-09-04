import { getDatabase } from '../../src/db.js';
import { bindAccountReportingCurrency } from '../../src/trading_money_ledger.js';

/** Economic fixtures use real, explicit simulated contract provenance, never position PnL as a source. */
export async function insertAccountedFill({ intentId, accountId = 'paper-default', id, role = 'entry', side,
  price, quantity = '1', fee = '0', feeAsset = 'USDT', filledAt, plannedPrice = price, legacy = false, symbol = 'BTCUSDT' }) {
  const database = getDatabase();
  await bindAccountReportingCurrency({ accountId, accountFingerprint: `paper:${accountId}`, profile: 'paper',
    reportingCurrency: 'USDT', settlementAssets: ['USDT'], source: 'paper-contract-v1', verifiedAt: filledAt });
  const metadata = JSON.stringify({ version: 1, source: 'paper-contract-v1', providerSymbol: symbol,
    settlementAsset: 'USDT', linear: true, quantityUnit: 'base' });
  await database.run(`INSERT INTO trading_orders (id, intent_id, account_id, client_order_id, exchange_order_id, provider_symbol,
    role, side, order_type, status, price, quantity, filled_quantity, reduce_only, request_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'limit', 'filled', ?, ?, ?, ?, '{}', ?, ?)`,
  [`order-${id}`, intentId, accountId, `client-${id}`, `remote-order-${id}`, symbol, role, side ?? (role === 'entry' ? 'buy' : 'sell'),
    plannedPrice, quantity, quantity, role === 'entry' ? 0 : 1, filledAt - 1, filledAt]);
  await database.run(`INSERT INTO trading_fills (id, order_id, account_id, exchange_fill_id, price, quantity,
    fee, fee_asset, filled_at, raw_json, account_fingerprint, accounting_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)`,
  [`fill-${id}`, `order-${id}`, accountId, `remote-fill-${id}`, price, quantity, fee, feeAsset, filledAt,
    legacy ? null : `paper:${accountId}`, legacy ? null : metadata]);
}
