import { getDatabase } from './db.js';

/** Retained history is not a live account. Unresolved obligations remain relevant even on an inconsistent retired row. */
export async function tradingAccountTargetIds(includeIdle = false): Promise<string[]> {
  const rows = await getDatabase().all<Array<{ id: string }>>(`
    SELECT account.id FROM trading_accounts AS account
    WHERE account.enabled = 1 OR (? = 1 AND account.retired_at IS NULL)
      OR EXISTS (SELECT 1 FROM trading_positions AS position WHERE position.account_id = account.id AND position.status <> 'closed')
      OR EXISTS (SELECT 1 FROM trading_orders AS orders WHERE orders.account_id = account.id AND orders.status NOT IN ('filled', 'cancelled', 'rejected'))
      OR EXISTS (SELECT 1 FROM trading_operations AS operation WHERE operation.account_id = account.id AND operation.phase NOT IN ('resolved', 'abandoned'))
      OR EXISTS (SELECT 1 FROM trading_trade_intents AS intent WHERE intent.account_id = account.id AND intent.status NOT IN ('completed', 'blocked', 'failed'))
      OR EXISTS (SELECT 1 FROM trading_remote_evidence AS evidence WHERE evidence.account_id = account.id AND evidence.classification IN ('unresolved', 'conflict'))
      OR EXISTS (SELECT 1 FROM trading_account_incidents AS incident WHERE incident.account_id = account.id AND incident.status = 'open')
      OR EXISTS (SELECT 1 FROM trading_risk_events AS risk WHERE risk.account_id = account.id AND risk.severity = 'critical' AND risk.acknowledged_at IS NULL)
    ORDER BY account.id`, [includeIdle ? 1 : 0]);
  return rows.map(row => row.id);
}
