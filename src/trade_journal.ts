import { createHash } from 'node:crypto';
import type { Database } from 'sqlite';
import { getDatabase, withDatabaseTransaction } from './db.js';
import { maskPII } from './logger.js';
import { projectAllFillAccounting } from './trading_fill_accounting.js';
import { addSignedDecimal, signedDecimal } from './trading_decimal.js';
import { moneyEventsForIntent } from './trading_money_ledger.js';
import type { MoneyEvent } from './trading_money_contract.js';
import { summarizeMoneyRows, type ClosedMoneyRow, type MoneySummary } from './trading_money_reporting.js';
import { moneyValueFromDecimal, validateMoneyValue } from './trading_money_value.js';

const MAXIMUM_JOURNAL_ROWS = 500;
const MAXIMUM_TAGS = 20;
const MAXIMUM_TAG_LENGTH = 40;

export interface TradeJournalFilters {
  intentId?: string;
  from?: number;
  to?: number;
  accountId?: string;
  channelId?: string;
  symbol?: string;
  status?: string;
  reviewed?: boolean;
  limit?: number;
}

export interface TradeJournalEntry {
  intentId: string;
  createdAt: number;
  updatedAt: number;
  channelId: string;
  accountId: string;
  accountName: string;
  exchange: string;
  mode: string;
  symbol: string;
  side: string;
  status: string;
  blockReason: string | null;
  error: string | null;
  strategy: {
    id: string;
    strategyId: string;
    version: number;
    name: string;
    configurationSha256: string;
  };
  signal: {
    id: string;
    schemaProfileId: string | null;
    schemaProfileName: string | null;
    contractVersionId: string | null;
    contractDefinitionSha256: string | null;
    templateName: string | null;
    parserSchema: string | null;
    parserVersion: string | null;
    promptSha256: string | null;
    model: string | null;
    providerRequestId: string | null;
    sourceChatFingerprint: string | null;
    sourceMessageId: number | null;
    sourceExcerpt: string | null;
    executable: unknown;
  };
  plan: unknown;
  position: Record<string, unknown> | null;
  orders: Array<Record<string, unknown>>;
  fills: Array<Record<string, unknown>>;
  fees: Record<string, string>;
  money: JournalMoneyDetails;
  timeline: Record<string, number>;
  review: {
    notes: string;
    tags: string[];
    rating: number | null;
    reviewed: boolean;
    updatedAt: number | null;
  };
}

function boundedIdentifier(value: unknown, label: string, maximum = 128): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum || /[\r\n\0]/.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value.trim();
}

function optionalTimestamp(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} is invalid.`);
  return parsed;
}

type NormalizedJournalFilters = Required<Pick<TradeJournalFilters, 'limit'>> & TradeJournalFilters;

function timestampRange(input: TradeJournalFilters): { from?: number; to?: number } {
  const from = optionalTimestamp(input.from, 'Journal start timestamp');
  const to = optionalTimestamp(input.to, 'Journal end timestamp');
  if (from !== undefined && to !== undefined && from > to) {
    throw new Error('Journal start timestamp must not be after the end timestamp.');
  }
  return { from, to };
}

function journalLimit(value: unknown = 200): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > MAXIMUM_JOURNAL_ROWS) {
    throw new Error(`Journal limit must be between 1 and ${MAXIMUM_JOURNAL_ROWS}.`);
  }
  return Number(value);
}

function journalSymbol(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const symbol = value.trim().toUpperCase();
  if (!/^[A-Z0-9]{2,30}(?:USD|USDC|USDT)$/.test(symbol)) {
    throw new Error('Journal symbol must be a normalized USD pair.');
  }
  return symbol;
}

function journalStatus(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const status = value.trim();
  const allowed = ['pending', 'planned', 'submitting', 'monitoring', 'completed', 'blocked', 'failed', 'unknown'];
  if (!allowed.includes(status)) throw new Error('Journal status is invalid.');
  return status;
}

function optionalIdentifier(value: unknown, label: string, maximum: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return boundedIdentifier(value, label, maximum);
}

function normalizedFilters(input: TradeJournalFilters = {}): NormalizedJournalFilters {
  const range = timestampRange(input);
  return {
    ...input,
    ...range,
    limit: journalLimit(input.limit),
    symbol: journalSymbol(input.symbol),
    status: journalStatus(input.status),
    accountId: optionalIdentifier(input.accountId, 'Account identifier', 64),
    channelId: optionalIdentifier(input.channelId, 'Channel identifier', 128),
  };
}

function parsedJson(value: unknown, fallback: unknown): unknown {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function tags(value: unknown): string[] {
  const parsed = Array.isArray(value) ? value : parsedJson(value, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((tag): tag is string => typeof tag === 'string').slice(0, MAXIMUM_TAGS);
}

function sourceFingerprint(chatId: unknown): string | null {
  if (typeof chatId !== 'string' || !chatId) return null;
  return createHash('sha256').update(`tsx-core-journal:${chatId}`, 'utf8').digest('hex').slice(0, 16);
}

function feeTotals(fills: Array<Record<string, unknown>>): Record<string, string> {
  const totals: Record<string, string> = {};
  for (const fill of fills) {
    const asset = typeof fill.feeAsset === 'string' && fill.feeAsset ? fill.feeAsset : 'UNKNOWN';
    if (typeof fill.fee !== 'string') throw new Error('Journal fill fee is unresolved.');
    totals[asset] = addSignedDecimal(totals[asset] ?? '0', signedDecimal(fill.fee));
  }
  return totals;
}

function placeholders(values: string[]): string {
  return values.map(() => '?').join(', ');
}

function groupBy<T>(
  values: T[],
  key: (value: T) => string,
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const itemKey = key(value);
    const existing = grouped.get(itemKey);
    if (existing) existing.push(value);
    else grouped.set(itemKey, [value]);
  }
  return grouped;
}

type JournalRow = Record<string, any>;

type JournalRelations = {
  ordersByIntent: Map<string, JournalRow[]>;
  fillsByIntent: Map<string, JournalRow[]>;
  timelineByIntent: Map<string, JournalRow[]>;
  schemaById: Map<string, JournalRow>;
  moneyByIntent: Map<string, JournalMoneyDetails>;
};

export interface JournalMoneyDetails extends MoneySummary {
  pricePnl: MoneySummary;
  signedFees: MoneySummary;
  funding: MoneySummary;
  events: MoneyEvent[];
}

/** Reads only persisted projection fields; a missing decimal alias is not missing money. */
export function journalProjectedMoney(row: {
  realized_pnl: string | null; value_json: string | null;
  accounting_status: string; reporting_currency: string | null;
}): MoneySummary {
  const source: ClosedMoneyRow = { realizedPnl: row.realized_pnl, accountingStatus: row.accounting_status,
    reportingCurrency: row.reporting_currency };
  if (row.value_json !== null && row.value_json !== undefined) {
    try { source.realizedPnlValue = validateMoneyValue(JSON.parse(row.value_json)); }
    catch { source.realizedPnlValue = null; source.accountingStatus = 'unresolved'; }
  }
  return summarizeMoneyRows([source]);
}

function eventMoneyRow(event: MoneyEvent): ClosedMoneyRow {
  return { realizedPnl: event.reportingAmount, realizedPnlValue: event.reportingValue,
    reportingCurrency: event.reportingCurrency, accountingStatus: event.valuationStatus === 'valued' ? 'complete' : 'unresolved' };
}

function journalComponent(events: MoneyEvent[], projection: MoneySummary): MoneySummary {
  const rows = events.map(eventMoneyRow);
  if (projection.accountingStatus !== 'complete') {
    rows.push({ realizedPnl: null, realizedPnlValue: null, reportingCurrency: null, accountingStatus: 'unresolved' });
  } else if (rows.length === 0) {
    // Absence is zero only behind a complete intent accounting projection, never from missing fee evidence.
    rows.push({ realizedPnl: '0', realizedPnlValue: { ...moneyValueFromDecimal('0'), terms: 0 },
      reportingCurrency: projection.reportingCurrency, accountingStatus: 'complete' });
  }
  return summarizeMoneyRows(rows);
}

/** Canonical event reader shared by journal and viewer; never joins the legacy valuation table. */
export async function journalMoneyDetails(intentId: string): Promise<JournalMoneyDetails> {
  return withDatabaseTransaction(async database => {
    const row = await database.get(`SELECT projection.realized_pnl, projection.value_json, projection.reporting_currency,
      CASE WHEN pending.intent_id IS NULL THEN projection.status ELSE 'unresolved' END AS accounting_status
      FROM trading_accounting_projections projection LEFT JOIN trading_accounting_pending pending ON pending.intent_id = projection.intent_id
      WHERE projection.intent_id = ?`, [intentId]);
    const projection = row ? journalProjectedMoney(row) : summarizeMoneyRows([]);
    const events = await moneyEventsForIntent(intentId);
    return { ...journalComponent(events, projection),
      pricePnl: journalComponent(events.filter(event => event.kind === 'realized_price_pnl'), projection),
      signedFees: journalComponent(events.filter(event => event.kind === 'fee'), projection),
      funding: journalComponent(events.filter(event => event.kind === 'funding'), projection), events };
  });
}

function journalWhere(filters: NormalizedJournalFilters): { where: string; parameters: unknown[] } {
  const conditions: string[] = [];
  const parameters: unknown[] = [];
  const add = (condition: string, value: unknown) => {
    conditions.push(condition);
    parameters.push(value);
  };
  if (filters.from !== undefined) add('intent.created_at >= ?', filters.from);
  if (filters.to !== undefined) add('intent.created_at <= ?', filters.to);
  if (filters.accountId) add('intent.account_id = ?', filters.accountId);
  if (filters.channelId) add('intent.channel_id = ?', filters.channelId);
  if (filters.symbol) add('intent.symbol = ?', filters.symbol);
  if (filters.status) add('intent.status = ?', filters.status);
  if (filters.reviewed !== undefined) add('COALESCE(journal.reviewed, 0) = ?', filters.reviewed ? 1 : 0);
  if (filters.intentId) add('intent.id = ?', boundedIdentifier(filters.intentId, 'Trade intent identifier', 64));
  return {
    where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    parameters,
  };
}

async function loadJournalRows(
  database: Database,
  filters: NormalizedJournalFilters,
): Promise<JournalRow[]> {
  const { where, parameters } = journalWhere(filters);
  return database.all<JournalRow[]>(
    `SELECT intent.*, account.name AS account_name,
            strategy.strategy_id, strategy.version AS strategy_version,
            strategy.name AS strategy_name,
            strategy.configuration_sha256,
            signal.chat_id, signal.message_id, signal.template_name,
            signal.schema_name, signal.prompt_sha256, signal.model,
            signal.provider_request_id, signal.parser_version,
            incoming.text AS source_text,
            position.id AS position_id, position.status AS position_status,
            position.quantity AS position_quantity,
            position.average_entry_price, position.stop_price,
            CASE WHEN accounting_pending.intent_id IS NULL THEN position.ledger_realized_pnl END AS realized_pnl,
            position.ledger_realized_value_json AS value_json,
            CASE WHEN accounting_pending.intent_id IS NULL THEN position.accounting_status ELSE 'unresolved' END AS accounting_status,
            position.reporting_currency, position.opened_at, position.closed_at,
            journal.notes, journal.tags_json, journal.rating,
            journal.reviewed, journal.updated_at AS journal_updated_at
     FROM trading_trade_intents AS intent
     JOIN trading_accounts AS account ON account.id = intent.account_id
     JOIN trading_strategy_versions AS strategy ON strategy.id = intent.strategy_version_id
     JOIN signals AS signal ON signal.id = intent.source_signal_id
     LEFT JOIN incoming_messages AS incoming
       ON incoming.chat_id = signal.chat_id AND incoming.message_id = signal.message_id
     LEFT JOIN trading_positions AS position ON position.intent_id = intent.id
     LEFT JOIN trading_accounting_pending AS accounting_pending ON accounting_pending.intent_id = intent.id
     LEFT JOIN trading_journal_entries AS journal ON journal.intent_id = intent.id
     ${where}
     ORDER BY intent.created_at DESC, intent.id DESC LIMIT ?`,
    [...parameters, filters.limit],
  );
}

async function loadJournalOrders(database: Database, intentIds: string[]): Promise<JournalRow[]> {
  return database.all<JournalRow[]>(
    `SELECT id, intent_id AS intentId, client_order_id AS clientOrderId,
            exchange_order_id AS exchangeOrderId, role, side,
            order_type AS orderType, status, price, trigger_price AS triggerPrice,
            quantity, filled_quantity AS filledQuantity, reduce_only AS reduceOnly,
            last_error AS error, created_at AS createdAt, updated_at AS updatedAt
     FROM trading_orders WHERE intent_id IN (${placeholders(intentIds)})
     ORDER BY created_at, id`,
    intentIds,
  );
}

async function loadJournalFills(database: Database, orders: JournalRow[]): Promise<JournalRow[]> {
  const orderIds = orders.map(order => String(order.id));
  if (orderIds.length === 0) return [];
  return database.all<JournalRow[]>(
    `SELECT fill.id, orders.intent_id AS intentId, fill.order_id AS orderId,
            fill.exchange_fill_id AS exchangeFillId, fill.price, fill.quantity,
            fill.provider_symbol AS providerSymbol, fill.remote_fill_key AS remoteFillKey, fill.identity_status AS identityStatus,
            fill.fee, fill.fee_asset AS feeAsset, fill.filled_at AS filledAt
     FROM trading_fills AS fill
     JOIN trading_orders AS orders ON orders.id = fill.order_id
     WHERE fill.order_id IN (${placeholders(orderIds)})
     ORDER BY fill.filled_at, fill.id`,
    orderIds,
  );
}

async function loadJournalTimelines(database: Database, intentIds: string[]): Promise<JournalRow[]> {
  return database.all<JournalRow[]>(
    `SELECT intent_id AS intentId, event_type AS eventType, MIN(occurred_at) AS occurredAt
     FROM trading_execution_events
     WHERE intent_id IN (${placeholders(intentIds)})
     GROUP BY intent_id, event_type`,
    intentIds,
  );
}

function executableSchemaId(value: unknown): string | null {
  const executable = parsedJson(value, {}) as Record<string, unknown>;
  return typeof executable.schema === 'string' ? executable.schema : null;
}

async function loadJournalSchemas(database: Database, rows: JournalRow[]): Promise<JournalRow[]> {
  const schemaIds = [...new Set(rows.map(row => {
    return executableSchemaId(row.signal_json);
  }).filter((value): value is string => Boolean(value)))];
  if (schemaIds.length === 0) return [];
  return database.all<JournalRow[]>(
    `SELECT schema.id, schema.name, schema.contract_version_id AS contractVersionId,
            version.definition_sha256 AS definitionSha256
     FROM trading_signal_schemas AS schema
     JOIN trading_signal_contract_versions AS version ON version.id = schema.contract_version_id
     WHERE schema.id IN (${placeholders(schemaIds)})`,
    schemaIds,
  );
}

async function loadJournalRelations(database: Database, rows: JournalRow[]): Promise<JournalRelations> {
  const intentIds = rows.map(row => String(row.id));
  const [orders, timelines, schemas] = await Promise.all([
    loadJournalOrders(database, intentIds),
    loadJournalTimelines(database, intentIds),
    loadJournalSchemas(database, rows),
  ]);
  const fills = await loadJournalFills(database, orders);
  const money = await Promise.all(intentIds.map(async id => [id, await journalMoneyDetails(id)] as const));
  return {
    ordersByIntent: groupBy(orders, order => String(order.intentId)),
    fillsByIntent: groupBy(fills, fill => String(fill.intentId)),
    timelineByIntent: groupBy(timelines, event => String(event.intentId)),
    schemaById: new Map(schemas.map(schema => [String(schema.id), schema])),
    moneyByIntent: new Map(money),
  };
}

function nullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  return JSON.stringify(value) || null;
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function journalSourceExcerpt(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return maskPII(value).replace(/\s+/g, ' ').trim().slice(0, 500);
}

function journalPosition(row: JournalRow): Record<string, unknown> | null {
  if (row.position_id === null) return null;
  return {
    id: String(row.position_id),
    status: String(row.position_status),
    quantity: String(row.position_quantity),
    averageEntryPrice: nullableString(row.average_entry_price),
    stopPrice: String(row.stop_price),
    ...journalProjectedMoney({ realized_pnl: row.realized_pnl, value_json: row.value_json,
      accounting_status: row.accounting_status, reporting_currency: row.reporting_currency }),
    openedAt: nullableNumber(row.opened_at),
    closedAt: nullableNumber(row.closed_at),
  };
}

function journalSignal(row: JournalRow, schema: JournalRow | undefined, executable: unknown) {
  return {
    id: String(row.source_signal_id),
    schemaProfileId: executableSchemaId(row.signal_json),
    schemaProfileName: nullableString(schema?.name),
    contractVersionId: nullableString(schema?.contractVersionId),
    contractDefinitionSha256: nullableString(schema?.definitionSha256),
    templateName: nullableString(row.template_name),
    parserSchema: nullableString(row.schema_name),
    parserVersion: nullableString(row.parser_version),
    promptSha256: nullableString(row.prompt_sha256),
    model: nullableString(row.model),
    providerRequestId: nullableString(row.provider_request_id),
    sourceChatFingerprint: sourceFingerprint(row.chat_id),
    sourceMessageId: nullableNumber(row.message_id),
    sourceExcerpt: journalSourceExcerpt(row.source_text),
    executable,
  };
}

function journalTimeline(events: JournalRow[]): Record<string, number> {
  return Object.fromEntries(events.map(event => [event.eventType, Number(event.occurredAt)]));
}

function mapJournalRow(row: JournalRow, relations: JournalRelations): TradeJournalEntry {
  const intentId = String(row.id);
  const rowOrders = (relations.ordersByIntent.get(intentId) || [])
    .map(order => ({ ...order, reduceOnly: Boolean(order.reduceOnly) }));
  const rowFills = relations.fillsByIntent.get(intentId) || [];
  const executable = parsedJson(row.signal_json, {});
  const schemaId = executableSchemaId(row.signal_json);
  const schema = schemaId ? relations.schemaById.get(schemaId) : undefined;
  return {
    intentId,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    channelId: String(row.channel_id),
    accountId: String(row.account_id),
    accountName: String(row.account_name),
    exchange: String(row.exchange),
    mode: String(row.mode),
    symbol: String(row.symbol),
    side: String(row.side),
    status: String(row.status),
    blockReason: nullableString(row.block_reason),
    error: nullableString(row.last_error),
    strategy: {
      id: String(row.strategy_version_id),
      strategyId: String(row.strategy_id),
      version: Number(row.strategy_version),
      name: String(row.strategy_name),
      configurationSha256: String(row.configuration_sha256),
    },
    signal: journalSignal(row, schema, executable),
    plan: parsedJson(row.plan_json, null),
    position: journalPosition(row),
    orders: rowOrders,
    fills: rowFills,
    fees: feeTotals(rowFills),
    money: relations.moneyByIntent.get(intentId)!,
    timeline: journalTimeline(relations.timelineByIntent.get(intentId) || []),
    review: {
      notes: nullableString(row.notes) || '',
      tags: tags(row.tags_json),
      rating: nullableNumber(row.rating),
      reviewed: Boolean(row.reviewed),
      updatedAt: nullableNumber(row.journal_updated_at),
    },
  };
}

export async function listTradeJournal(
  input: TradeJournalFilters = {},
): Promise<TradeJournalEntry[]> {
  await projectAllFillAccounting();
  return withDatabaseTransaction(async database => {
    const rows = await loadJournalRows(database, normalizedFilters(input));
    if (rows.length === 0) return [];
    const relations = await loadJournalRelations(database, rows);
    return rows.map(row => mapJournalRow(row, relations));
  });
}

export async function updateTradeJournalReview(input: {
  intentId: unknown;
  notes?: unknown;
  tags?: unknown;
  rating?: unknown;
  reviewed?: unknown;
}): Promise<TradeJournalEntry> {
  const intentId = boundedIdentifier(input.intentId, 'Trade intent identifier', 64);
  const notes = typeof input.notes === 'string' ? input.notes.trim() : '';
  if (notes.length > 10_000) throw new Error('Journal notes must not exceed 10000 characters.');
  if (!Array.isArray(input.tags) || input.tags.length > MAXIMUM_TAGS) {
    throw new Error(`Journal tags must contain at most ${MAXIMUM_TAGS} values.`);
  }
  const normalizedTags = [...new Set(input.tags.map(tag =>
    boundedIdentifier(tag, 'Journal tag', MAXIMUM_TAG_LENGTH),
  ))];
  const rating = input.rating === null || input.rating === undefined ? null : Number(input.rating);
  if (rating !== null && (!Number.isSafeInteger(rating) || rating < 1 || rating > 5)) {
    throw new Error('Journal rating must be between 1 and 5.');
  }
  if (typeof input.reviewed !== 'boolean') throw new Error('Journal reviewed state must be boolean.');
  const existing = await getDatabase().get('SELECT id FROM trading_trade_intents WHERE id = ?', [intentId]);
  if (!existing) throw new Error('Trade intent does not exist.');
  const now = Date.now();
  await getDatabase().run(
    `INSERT INTO trading_journal_entries (
       intent_id, notes, tags_json, rating, reviewed, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(intent_id) DO UPDATE SET
       notes = excluded.notes,
       tags_json = excluded.tags_json,
       rating = excluded.rating,
       reviewed = excluded.reviewed,
       updated_at = excluded.updated_at`,
    [intentId, notes, JSON.stringify(normalizedTags), rating, input.reviewed ? 1 : 0, now, now],
  );
  const [selected] = await listTradeJournal({ intentId, limit: 1 });
  if (!selected) throw new Error('Updated journal entry could not be read.');
  return selected;
}

function safeSpreadsheetCell(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

function csvCell(value: unknown): string {
  return `"${safeSpreadsheetCell(value).replaceAll('"', '""')}"`;
}

export function tradeJournalCsv(entries: TradeJournalEntry[]): string {
  const columns: Array<[string, (entry: TradeJournalEntry) => unknown]> = [
    ['intent_id', entry => entry.intentId],
    ['created_at', entry => new Date(entry.createdAt).toISOString()],
    ['status', entry => entry.status],
    ['exchange', entry => entry.exchange],
    ['mode', entry => entry.mode],
    ['account', entry => entry.accountName],
    ['channel_id', entry => entry.channelId],
    ['symbol', entry => entry.symbol],
    ['side', entry => entry.side],
    ['strategy', entry => `${entry.strategy.name} v${entry.strategy.version}`],
    ['strategy_sha256', entry => entry.strategy.configurationSha256],
    ['schema_profile', entry => entry.signal.schemaProfileId],
    ['contract_version', entry => entry.signal.contractVersionId],
    ['contract_sha256', entry => entry.signal.contractDefinitionSha256],
    ['realized_pnl', entry => entry.money.realizedPnl],
    ['realized_pnl_value', entry => entry.money.realizedPnlValue],
    ['reporting_currency', entry => entry.money.reportingCurrency],
    ['accounting_status', entry => entry.money.accountingStatus],
    ['valued_subtotals_by_currency', entry => entry.money.valuedSubtotalValuesByCurrency],
    ['price_pnl_value', entry => entry.money.pricePnl.realizedPnlValue],
    ['signed_fees_value', entry => entry.money.signedFees.realizedPnlValue],
    ['signed_fees_currency', entry => entry.money.signedFees.reportingCurrency],
    ['signed_fees_status', entry => entry.money.signedFees.accountingStatus],
    ['funding_value', entry => entry.money.funding.realizedPnlValue],
    ['funding_currency', entry => entry.money.funding.reportingCurrency],
    ['funding_status', entry => entry.money.funding.accountingStatus],
    ['money_components', entry => ({ pricePnl: entry.money.pricePnl, signedFees: entry.money.signedFees, funding: entry.money.funding })],
    ['fees', entry => entry.fees],
    ['fills', entry => entry.fills.length],
    ['reviewed', entry => entry.review.reviewed],
    ['rating', entry => entry.review.rating],
    ['tags', entry => entry.review.tags.join('|')],
    ['notes', entry => entry.review.notes],
    ['source_chat_fingerprint', entry => entry.signal.sourceChatFingerprint],
    ['source_message_id', entry => entry.signal.sourceMessageId],
    ['source_excerpt', entry => entry.signal.sourceExcerpt],
  ];
  return [
    columns.map(([name]) => csvCell(name)).join(','),
    ...entries.map(entry => columns.map(([, read]) => csvCell(read(entry))).join(',')),
  ].join('\r\n');
}
