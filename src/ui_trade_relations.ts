import { withDatabaseTransaction } from './db.js';
import type { Database } from 'sqlite';
import { decodeUiCursor, encodeUiCursor, filterFingerprint } from './ui_cursor.js';
import { uiObjectId } from './ui_trading_reads.js';
import { getMoneyEvent } from './trading_money_ledger.js';
import { readFxMoneyValuation } from './trading_fx_valuation.js';
import { readFxConversion } from './trading_fx_repository.js';
import { getTradingAccount } from './trading_repository.js';
import { redactReview } from './ui_change_review.js';
import type { TradeJournalEntry } from './trade_journal.js';

const RELATIONS = {
  orders: { table: 'trading_orders', clock: 'created_at', scope: 'intent_id = ?', fields: 'id, client_order_id AS clientOrderId, exchange_order_id AS exchangeOrderId, role, side, order_type AS orderType, status, price, trigger_price AS triggerPrice, quantity, filled_quantity AS filledQuantity, reduce_only AS reduceOnly, last_error AS reason, created_at AS createdAt, updated_at AS updatedAt' },
  fills: { table: 'trading_fills', clock: 'filled_at', scope: 'order_id IN (SELECT id FROM trading_orders WHERE intent_id = ?)', fields: 'id, order_id AS orderId, exchange_fill_id AS exchangeFillId, provider_symbol AS providerSymbol, identity_status AS identityStatus, price, quantity, fee, fee_asset AS feeAsset, filled_at AS filledAt' },
  money: { table: 'trading_money_events', clock: 'recorded_at', scope: 'intent_id = ?', fields: 'id, kind, amount, asset, occurred_at AS occurredAt, recorded_at AS recordedAt' },
  events: { table: 'trading_execution_events', clock: 'occurred_at', scope: 'intent_id = ?', fields: "id, event_type AS eventType, channel_id AS channelId, account_id AS accountId, exchange, mode, correlation_id AS correlationId, occurred_at AS occurredAt, CASE WHEN length(details_json) <= 16000 THEN details_json END AS detailsJson, length(details_json) > 16000 AS detailsOmitted" },
} as const;
export type UiTradeRelation = keyof typeof RELATIONS;

type MoneyVisibleEvent = Record<string, unknown>;

async function moneyConversion(moneyId: string): Promise<{ conversion: unknown; valuationReason: string | null }> {
  try {
    const valuation = await readFxMoneyValuation(moneyId);
    if (!valuation) return { conversion: null, valuationReason: null };
    const event = await getMoneyEvent(moneyId);
    const account = event ? await getTradingAccount(event.accountId) : null;
    if (!account) throw new Error('FX account binding is unavailable.');
    return { conversion: (await readFxConversion(account, valuation.conversionId)).conversion, valuationReason: null };
  } catch (error) { return { conversion: null, valuationReason: String(error).slice(0, 2000) }; }
}

async function moneyEvidence(id: string) {
  const event = await getMoneyEvent(id); if (!event) throw new Error('Original monetary event is unavailable.');
  const { accountFingerprint: _privateIdentity, ...visible } = event;
  const { conversion, valuationReason } = await moneyConversion(id);
  return { ...(visible as MoneyVisibleEvent), conversion, valuationReason, explanation: conversion
    ? 'Geprüfte ereigniszeitbezogene Provider-Indexbewertung. Rate ist exakt rational; Zeitablauf allein bewertet das historische Ereignis nicht neu.'
    : 'Native Bewertung oder kein aktuell prüfbarer FX-Konversionsbeleg. Unbekannte Bewertung ist kein Nullbetrag.' };
}

function orderEvidence(row: Record<string, unknown>): unknown {
  return redactReview({ ...row, reduceOnly: row.reduceOnly === 1 });
}

function eventEvidence(row: Record<string, unknown>): unknown {
  const { detailsJson, ...event } = row;
  return redactReview({ ...event, detailsOmitted: Boolean(event.detailsOmitted), details: detailsJson ? JSON.parse(detailsJson as string) : null });
}

async function moneyRelationEvidence(row: Record<string, unknown>): Promise<unknown> {
  try { return redactReview(await moneyEvidence(row.id as string)); }
  catch (error) { return { ...row, valuationStatus: 'unresolved', valuationReason: String(error).slice(0, 2000), originalUnverified: true }; }
}

function relationEvidence(kind: UiTradeRelation, row: Record<string, unknown>): Promise<unknown> {
  if (kind === 'money') return moneyRelationEvidence(row);
  if (kind === 'events') return Promise.resolve(eventEvidence(row));
  if (kind === 'orders') return Promise.resolve(orderEvidence(row));
  return Promise.resolve(redactReview({ ...row }));
}

/** Relations are independently pageable; no raw account fingerprints, provider payloads or floating-point money. */
export async function uiTradeRelationPage(intentId: string, kind: UiTradeRelation, query: URLSearchParams) {
  uiObjectId(intentId, 64);
  if (!Object.hasOwn(RELATIONS, kind)) throw new Error('Unsupported trade relation.');
  const limit = Number(query.get('limit') || 40);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid trade relation page size.');
  const definition = RELATIONS[kind]; const filter = filterFingerprint({ intentId, kind, limit });
  const cursor = decodeUiCursor(query.get('cursor'), filter);
  const observedAt = cursor?.observedAt ?? Date.now();
  await Promise.resolve();
  return withDatabaseTransaction(database => relationPage(database, intentId, kind, definition, filter, observedAt, cursor, limit));
}

function relationPageWindow(
  definition: (typeof RELATIONS)[UiTradeRelation], intentId: string, observedAt: number,
  cursor: { createdAt: number; id: string } | null,
): { where: string[]; parameters: unknown[] } {
  const where = [definition.scope, `${definition.clock} <= ?`];
  const parameters: unknown[] = [intentId, observedAt];
  if (cursor) { where.push(`(${definition.clock} < ? OR (${definition.clock} = ? AND id < ?))`); parameters.push(cursor.createdAt, cursor.createdAt, cursor.id); }
  return { where, parameters };
}

async function relationPageEntries(
  database: Database,
  definition: (typeof RELATIONS)[UiTradeRelation], where: string[], parameters: unknown[], limit: number, kind: UiTradeRelation,
): Promise<{ rows: Array<Record<string, unknown>>; entries: unknown[] }> {
  const rows = await database.all(`SELECT ${definition.fields}, ${definition.clock} AS cursorTime FROM ${definition.table} WHERE ${where.join(' AND ')} ORDER BY ${definition.clock} DESC, id DESC LIMIT ?`, [...parameters, limit + 1]);
  const entries = [];
  for (const { cursorTime: _clock, ...row } of rows.slice(0, limit)) {
    entries.push(await relationEvidence(kind, row));
  }
  return { rows, entries };
}

async function relationPage(
  database: Database,
  intentId: string, kind: UiTradeRelation, definition: (typeof RELATIONS)[UiTradeRelation],
  filter: string, observedAt: number, cursor: { createdAt: number; id: string } | null, limit: number,
): Promise<unknown> {
  if (!await database.get('SELECT id FROM trading_trade_intents WHERE id = ?', [intentId])) return null;
  const { where, parameters } = relationPageWindow(definition, intentId, observedAt, cursor);
  const { rows, entries } = await relationPageEntries(database, definition, where, parameters, limit, kind);
  const last = rows[Math.min(limit, rows.length) - 1];
  return { contractVersion: 1, intentId, kind, entries, observedAt, hasMore: rows.length > limit,
    snapshotContext: 'Creation/recording cutoff; status and valuation are checked at the page observation. Event details above 16000 characters are explicitly omitted.',
    nextCursor: rows.length > limit && last ? encodeUiCursor({ version: 1, filter, observedAt, createdAt: last.cursorTime as number, id: last.id as string }) : null };
}

/** Aggregations still cover every original; relation rows are fetched through their bounded page contract. */
export function uiJournalDetail(entry: TradeJournalEntry) {
  return { ...entry, orders: [], fills: [], money: { ...entry.money, events: [] },
    relationCounts: { orders: entry.orders.length, fills: entry.fills.length, money: entry.money.events.length },
    relationEndpoint: '/api/trading/intents/relations', relatedRowsIncluded: false };
}
export function uiJournalSummary(entry: TradeJournalEntry) {
  const { plan: _plan, signal: _signal, review, timeline: _timeline, fees: _fees, ...summary } = uiJournalDetail(entry);
  return { ...summary, review: { reviewed: review.reviewed, rating: review.rating, updatedAt: review.updatedAt }, detailsIncluded: false };
}
