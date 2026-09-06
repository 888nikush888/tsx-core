import { getDatabase } from './db.js';
import { getTradingOverview } from './trading_repository.js';
import { analyticsPositionMoneyRow, listTradingEquityPoints } from './trading_telemetry.js';
import { uiTradingPage } from './ui_trading_reads.js';
import { readProtectionProjection } from './trading_protection_projection.js';

/** Current operating slice. Counts are global; original detail and full selection have separate read contracts. */
export async function uiCockpit() {
  const database = getDatabase();
  const [overview, accounts, positions, orders, incidents, risks, intents, equityHistory, fallbackRuns] = await Promise.all([
    getTradingOverview(), uiTradingPage('accounts', new URLSearchParams({ limit: '100' })),
    database.all(`SELECT id,intent_id AS intentId,account_id AS accountId,symbol,side,status,quantity,average_entry_price AS averageEntryPrice,
      stop_price AS stopPrice,ledger_realized_pnl AS realizedPnl,ledger_realized_value_json AS realizedPnlValueJson,
      CASE WHEN EXISTS(SELECT 1 FROM trading_accounting_pending pending WHERE pending.intent_id=trading_positions.intent_id)
        THEN 'unresolved' ELSE accounting_status END AS accountingStatus,reporting_currency AS reportingCurrency,updated_at AS updatedAt
      FROM trading_positions WHERE status IN ('opening','open','closing','emergency') ORDER BY updated_at DESC,id DESC LIMIT 51`),
    uiTradingPage('orders', new URLSearchParams({ status: 'unknown', limit: '50' })),
    uiTradingPage('incidents', new URLSearchParams({ status: 'open', limit: '30' })),
    uiTradingPage('risk-events', new URLSearchParams({ status: 'unacknowledged', limit: '30' })),
    database.all(`SELECT id,account_id AS accountId,channel_id AS channelId,symbol,side,status,created_at AS createdAt FROM trading_trade_intents
      WHERE status IN ('pending','planned','submitting','monitoring','unknown') ORDER BY created_at DESC,id DESC LIMIT 51`),
    listTradingEquityPoints(undefined, Date.now() - 90 * 86400000, 1000),
    database.all(`SELECT id,source_signal_id AS sourceSignalId,channel_id AS channelId,status,substr(stop_reason,1,2000) AS stopReason,created_at AS createdAt
      FROM trading_fallback_runs ORDER BY created_at DESC,id DESC LIMIT 8`),
  ]);
  const protection = positions.length ? await readProtectionProjection() : [];
  const byIntent = new Map(protection.map(row => [row.intentId, { protected: row.protected, reason: row.reason,
    evaluatedAt: row.proof?.evaluatedAt ?? null, acquisitionStartedAt: row.proof?.acquisitionStartedAt ?? null, evidenceHash: row.proof?.evidenceHash ?? null }]));
  return { contractVersion: 1, observedAt: Date.now(), overview, accounts: accounts.entries,
    activity: { positions: positions.slice(0, 50).map(row => { const result = analyticsPositionMoneyRow(row); delete result.realizedPnlValueJson; return { ...result, protection: byIntent.get(row.intentId) ?? null }; }),
      orders: orders.entries, riskEvents: risks.entries, fills: [], reconciliations: [], paperMarkets: [] },
    intents: intents.slice(0, 50), accountIncidents: incidents.entries.map(row => ({ ...row, message: row.reason })), equityHistory,
    fallbackRuns: fallbackRuns.map(row => ({ ...row, candidates: [] })),
    coverage: { accounts: accounts.hasMore, positions: positions.length > 50, orders: orders.hasMore, incidents: incidents.hasMore, risks: risks.hasMore, intents: intents.length > 50, equity: equityHistory.length === 1000 },
    interpretation: 'Betriebsausschnitt: bis 50 aktive Positionen/offene Intents, 50 unklare Orders, 30 Vorfälle/Risikoereignisse und 100 Kontonamen. Globale Zähler sind getrennte Gesamtabfragen. Pläne, Orders und Schutz im Originaldetail; Historie, Modelle und Konfiguration werden hier nicht mitgeladen.' };
}
