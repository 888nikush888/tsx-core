import { createHash, randomUUID } from 'node:crypto';

import { getDatabase } from './db.js';
import { recordTradingNotificationBestEffort } from './trading_notifications.js';

export type TradingIncidentCategory =
  | 'reconciliation_transient'
  | 'reconciliation_contract'
  | 'remote_identity'
  | 'unmanaged_remote'
  | 'unresolved_fill';

export interface TradingAccountIncident {
  id: string;
  accountId: string;
  fingerprint: string;
  category: TradingIncidentCategory;
  severity: 'warning' | 'critical';
  message: string;
  details: Record<string, unknown>;
  status: 'open' | 'resolved';
  occurrenceCount: number;
  firstSeenAt: number;
  lastSeenAt: number;
  resolvedAt: number | null;
}

function incidentFingerprint(category: TradingIncidentCategory, message: string): string {
  return createHash('sha256').update(`${category}\0${message.trim()}`).digest('hex');
}

function incidentFromRow(row: any): TradingAccountIncident {
  let details: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(String(row.details_json || '{}'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) details = parsed;
  } catch {
    details = {};
  }
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    fingerprint: String(row.fingerprint),
    category: row.category,
    severity: row.severity,
    message: String(row.message),
    details,
    status: row.status,
    occurrenceCount: Number(row.occurrence_count),
    firstSeenAt: Number(row.first_seen_at),
    lastSeenAt: Number(row.last_seen_at),
    resolvedAt: row.resolved_at === null ? null : Number(row.resolved_at),
  };
}

export async function recordTradingAccountIncident(input: {
  accountId: string;
  category: TradingIncidentCategory;
  severity: 'warning' | 'critical';
  message: string;
  details?: Record<string, unknown>;
  now?: number;
}): Promise<TradingAccountIncident> {
  const message = input.message.trim().slice(0, 1_000);
  if (!message) throw new Error('Trading account incident requires a message.');
  const now = input.now ?? Date.now();
  const fingerprint = incidentFingerprint(input.category, message);
  const existing = await getDatabase().get<any>(
    `SELECT * FROM trading_account_incidents
     WHERE account_id = ? AND fingerprint = ? AND status = 'open'`,
    [input.accountId, fingerprint],
  );
  if (existing) {
    await getDatabase().run(
      `UPDATE trading_account_incidents
       SET occurrence_count = occurrence_count + 1, last_seen_at = ?, details_json = ?
       WHERE id = ?`,
      [now, JSON.stringify(input.details || {}), existing.id],
    );
    return incidentFromRow({
      ...existing,
      occurrence_count: Number(existing.occurrence_count) + 1,
      last_seen_at: now,
      details_json: JSON.stringify(input.details || {}),
    });
  }
  const row = {
    id: randomUUID(),
    account_id: input.accountId,
    fingerprint,
    category: input.category,
    severity: input.severity,
    message,
    details_json: JSON.stringify(input.details || {}),
    status: 'open',
    occurrence_count: 1,
    first_seen_at: now,
    last_seen_at: now,
    resolved_at: null,
  };
  await getDatabase().run(
    `INSERT INTO trading_account_incidents (
       id, account_id, fingerprint, category, severity, message, details_json,
       status, occurrence_count, first_seen_at, last_seen_at, resolved_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', 1, ?, ?, NULL)`,
    [row.id, row.account_id, row.fingerprint, row.category, row.severity,
      row.message, row.details_json, row.first_seen_at, row.last_seen_at],
  );
  const incident = incidentFromRow(row);
  await recordTradingNotificationBestEffort({
    dedupeKey: `incident-open:${incident.id}`,
    eventType: 'account_incident_opened',
    accountId: incident.accountId,
    occurredAt: incident.firstSeenAt,
    details: {
      incidentId: incident.id, category: incident.category, severity: incident.severity,
      message: incident.message, occurrenceCount: incident.occurrenceCount,
    },
  });
  return incident;
}

export async function resolveTradingAccountIncidents(
  accountId: string,
  categories: TradingIncidentCategory[],
  now = Date.now(),
): Promise<number> {
  if (categories.length === 0) return 0;
  const placeholders = categories.map(() => '?').join(', ');
  const incidents = await getDatabase().all<any[]>(
    `SELECT id, category, severity, message, occurrence_count
     FROM trading_account_incidents
     WHERE account_id = ? AND status = 'open' AND category IN (${placeholders})`,
    [accountId, ...categories],
  );
  const result = await getDatabase().run(
    `UPDATE trading_account_incidents
     SET status = 'resolved', resolved_at = ?, last_seen_at = ?
     WHERE account_id = ? AND status = 'open' AND category IN (${placeholders})`,
    [now, now, accountId, ...categories],
  );
  for (const incident of incidents) {
    await recordTradingNotificationBestEffort({
      dedupeKey: `incident-resolved:${incident.id}`,
      eventType: 'account_incident_resolved',
      accountId,
      occurredAt: now,
      details: {
        incidentId: String(incident.id), category: String(incident.category), severity: String(incident.severity),
        message: String(incident.message), occurrenceCount: Number(incident.occurrence_count),
      },
    });
  }
  return Number(result.changes || 0);
}

export async function listTradingAccountIncidents(input: {
  accountId?: string;
  includeResolved?: boolean;
  limit?: number;
} = {}): Promise<TradingAccountIncident[]> {
  const limit = Math.max(1, Math.min(500, Math.floor(input.limit ?? 100)));
  const conditions: string[] = [];
  const parameters: unknown[] = [];
  if (input.accountId) {
    conditions.push('account_id = ?');
    parameters.push(input.accountId);
  }
  if (input.includeResolved !== true) conditions.push("status = 'open'");
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = await getDatabase().all<any[]>(
    `SELECT * FROM trading_account_incidents ${where}
     ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, last_seen_at DESC LIMIT ?`,
    [...parameters, limit],
  );
  return rows.map(incidentFromRow);
}
