// External incident receiver candidate. No Node APIs, account access, or background sends.
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const MAX_ALERTS = 100;
const DEDUPE_MS = 20 * 60 * 1000;
const TELEGRAM_TIMEOUT_MS = 8_000;
const encoder = new TextEncoder();

const SQL = Object.freeze({
  deleteExpired: "DELETE FROM incident_deliveries WHERE delivery_key = ? AND state = 'delivered' AND expires_at <= ?",
  insert: "INSERT OR IGNORE INTO incident_deliveries (delivery_key, state, created_at, updated_at, expires_at, retry_after) VALUES (?, 'pending', ?, ?, ?, 0)",
  acquireRetry: "UPDATE incident_deliveries SET state = 'pending', updated_at = ? WHERE delivery_key = ? AND state = 'retryable' AND retry_after <= ?",
  read: 'SELECT state FROM incident_deliveries WHERE delivery_key = ?',
  delivered: "UPDATE incident_deliveries SET state = 'delivered', updated_at = ?, expires_at = ?, telegram_message_id = ? WHERE delivery_key = ? AND state = 'pending'",
  retryable: "UPDATE incident_deliveries SET state = 'retryable', updated_at = ?, retry_after = ? WHERE delivery_key = ? AND state = 'pending'",
  unknown: "UPDATE incident_deliveries SET state = 'unknown', updated_at = ? WHERE delivery_key = ? AND state = 'pending'",
  cleanup: "DELETE FROM incident_deliveries WHERE delivery_key IN (SELECT delivery_key FROM incident_deliveries WHERE state = 'delivered' AND expires_at <= ? LIMIT 1000)",
});

function reply(status, message = '') {
  return new Response(message, { status, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' } });
}

function validSecret(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{32,256}$/u.test(value);
}

function configured(env) {
  return env && validSecret(env.RELAY_TOKEN) && validSecret(env.DEDUPE_SECRET)
    && typeof env.TELEGRAM_BOT_TOKEN === 'string'
    && /^[0-9]{6,}:[A-Za-z0-9_-]{20,}$/u.test(env.TELEGRAM_BOT_TOKEN)
    && typeof env.TELEGRAM_CHAT_ID === 'string'
    && /^-?[1-9][0-9]{0,19}$/u.test(env.TELEGRAM_CHAT_ID)
    && env.DB && typeof env.DB.prepare === 'function';
}

function authorized(header, expected) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const supplied = header.slice(7);
  if (supplied.length > 256) return false;
  const left = encoder.encode(supplied);
  const right = encoder.encode(expected);
  let difference = left.length ^ right.length;
  for (let index = 0; index < 256; index += 1) difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}

class RejectedPayload extends Error {
  constructor(status) {
    super('Invalid incident request');
    this.status = status;
  }
}

async function boundedStream(stream, limit) {
  const reader = stream.getReader();
  let result = new Uint8Array(Math.min(limit, 1024));
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > limit - length) throw new RejectedPayload(413);
      const needed = length + value.byteLength;
      if (needed > result.byteLength) {
        const capacity = Math.min(limit, Math.max(needed, result.byteLength * 2));
        const grown = new Uint8Array(capacity);
        grown.set(result.subarray(0, length));
        result = grown;
      }
      result.set(value, length);
      length = needed;
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* Caller still fails closed. */ }
    throw error;
  } finally {
    reader.releaseLock();
  }
  return result.subarray(0, length);
}

async function boundedBody(request) {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^[0-9]+$/u.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    throw new RejectedPayload(413);
  }
  if (!request.body) throw new RejectedPayload(400);
  const bytes = await boundedStream(request.body, MAX_BODY_BYTES);
  if (bytes.length === 0) throw new RejectedPayload(400);
  return bytes;
}

function alertDocument(bytes) {
  let envelope;
  try { envelope = JSON.parse(new TextDecoder('utf-8').decode(bytes)); }
  catch { throw new RejectedPayload(400); }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
    || !['firing', 'resolved'].includes(envelope.status)
    || !Array.isArray(envelope.alerts) || envelope.alerts.length > MAX_ALERTS
    || (envelope.truncatedAlerts !== undefined && envelope.truncatedAlerts !== 0)) {
    throw new RejectedPayload(envelope?.truncatedAlerts ? 422 : 400);
  }
  const alerts = envelope.alerts.map(alert => {
    if (!alert || typeof alert !== 'object' || Array.isArray(alert)
      || !alert.labels || typeof alert.labels !== 'object' || Array.isArray(alert.labels)) {
      throw new RejectedPayload(400);
    }
    if (typeof alert.labels.alertname !== 'string' || typeof alert.labels.severity !== 'string') {
      throw new RejectedPayload(400);
    }
    const selected = { alertname: alert.labels.alertname, severity: alert.labels.severity };
    for (const name of ['service', 'correlation_id']) {
      if (Object.hasOwn(alert.labels, name)) selected[name] = alert.labels[name];
    }
    return selected;
  });
  let document;
  try { document = encoder.encode(JSON.stringify({ status: envelope.status, count: alerts.length, alerts })); }
  catch { throw new RejectedPayload(400); }
  if (document.byteLength > MAX_DOCUMENT_BYTES) throw new RejectedPayload(413);
  return { document, caption: `TSX Core ${envelope.status.toUpperCase()}: ${alerts.length} alerts. Exact IDs in attached JSON.` };
}

async function deliveryKey(secret, bytes) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signed = new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes));
  return [...signed].map(part => part.toString(16).padStart(2, '0')).join('');
}

async function run(db, sql, ...values) {
  const result = await db.prepare(sql).bind(...values).run();
  if (!result?.success || !Number.isSafeInteger(result.meta?.changes)) throw new Error('D1 write unconfirmed');
  return result.meta.changes;
}

async function reserve(db, key, now) {
  await run(db, SQL.deleteExpired, key, now);
  if (await run(db, SQL.insert, key, now, now, now + DEDUPE_MS) === 1) return 'send';
  if (await run(db, SQL.acquireRetry, now, key, now) === 1) return 'send';
  const prior = await db.prepare(SQL.read).bind(key).first();
  return prior?.state === 'delivered' ? 'delivered' : 'blocked';
}

async function telegramSend(env, alert, key, fetchImpl) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`;
  const form = new FormData();
  form.set('chat_id', env.TELEGRAM_CHAT_ID);
  form.set('caption', `${alert.caption}\nreceipt=${key}`);
  form.set('disable_notification', 'false');
  form.set('document', new Blob([alert.document], { type: 'application/json' }), 'tsx-core-alerts.json');
  const response = await fetchImpl(url, {
    method: 'POST',
    body: form,
    redirect: 'error',
    signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
  });
  if (!response.body) return { state: 'unknown' };
  let body;
  try { body = new TextDecoder('utf-8', { fatal: true }).decode(await boundedStream(response.body, 8192)); }
  catch { return { state: 'unknown' }; }
  let parsed;
  try { parsed = JSON.parse(body); } catch { return { state: 'unknown' }; }
  return telegramOutcome(response.status, parsed);
}

function retryDelay(parsed) {
  const retryAfter = parsed?.parameters?.retry_after;
  return parsed?.ok === false && Number.isSafeInteger(retryAfter)
    && retryAfter >= 1 && retryAfter <= 3600 ? retryAfter * 1000 : null;
}

function confirmedMessageId(parsed) {
  const messageId = parsed?.result?.message_id;
  return parsed?.ok === true && Number.isSafeInteger(messageId) && messageId > 0 ? messageId : null;
}

function telegramOutcome(status, parsed) {
  const delay = retryDelay(parsed);
  if (status === 429 && delay !== null) return { state: 'retryable', retryAfterMs: delay };
  const messageId = confirmedMessageId(parsed);
  if (status >= 200 && status < 300 && messageId !== null) return { state: 'delivered', messageId };
  return { state: 'unknown' };
}

function gate(request, env) {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/healthz' && !url.search) return reply(200, 'alive');
  if (request.method !== 'POST' || url.pathname !== '/alerts' || url.search) return reply(404);
  if (!configured(env)) return reply(503);
  if (!authorized(request.headers.get('authorization'), env.RELAY_TOKEN)) return reply(401);
  if (request.headers.get('x-alert-source') !== 'tsx-core') return reply(403);
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(request.headers.get('content-type') ?? '')
    || ![null, 'identity'].includes(request.headers.get('content-encoding'))) return reply(415);
  return null;
}

async function sendReserved(env, bytes, alert, fetchImpl, now) {
  let key;
  try {
    key = await deliveryKey(env.DEDUPE_SECRET, bytes);
    const reservation = await reserve(env.DB, key, now());
    if (reservation === 'delivered') return reply(202);
    if (reservation !== 'send') return reply(503);
  } catch { return reply(503); }
  let outcome;
  try { outcome = await telegramSend(env, alert, key, fetchImpl); }
  catch { outcome = { state: 'unknown' }; }
  try {
    if (outcome.state === 'delivered') {
      const completedAt = now();
      if (await run(env.DB, SQL.delivered, completedAt, completedAt + DEDUPE_MS, outcome.messageId, key) === 1) return reply(202);
    } else if (outcome.state === 'retryable') {
      await run(env.DB, SQL.retryable, now(), now() + outcome.retryAfterMs, key);
    } else {
      await run(env.DB, SQL.unknown, now(), key);
    }
  } catch { /* Pending reservation remains blocked until operator reconciliation. */ }
  return reply(503);
}

/** Exposed for offline tests; production uses the default export below. */
export async function handleIncidentRequest(request, env, { fetchImpl = fetch, now = Date.now } = {}) {
  const rejected = gate(request, env);
  if (rejected) return rejected;
  let bytes;
  let alert;
  try {
    bytes = await boundedBody(request);
    alert = alertDocument(bytes);
  } catch (error) {
    return reply(error instanceof RejectedPayload ? error.status : 400);
  }
  return sendReserved(env, bytes, alert, fetchImpl, now);
}

export default {
  fetch(request, env) { return handleIncidentRequest(request, env); },
  async scheduled(_event, env) {
    if (!configured(env)) throw new Error('Incident receiver bindings unavailable');
    await run(env.DB, SQL.cleanup, Date.now());
  },
};
