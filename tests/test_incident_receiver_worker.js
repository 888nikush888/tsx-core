import assert from 'node:assert/strict';
import incidentWorker, { handleIncidentRequest } from '../services/incident-receiver-worker/worker.js';

const relayToken = 'r'.repeat(64);
const dedupeSecret = 'd'.repeat(64);
const botToken = `123456:${'t'.repeat(32)}`;
const chatId = '-100123456789';
const body = (status = 'firing', extra = {}) => JSON.stringify({
  status,
  alerts: [{ labels: { alertname: 'ForwarderUnknownDelivery', severity: 'critical', service: 'tsx-core',
    correlation_id: 'single_-1001_42' }, annotations: { summary: 'PRIVATE ALERT BODY' } }],
  ...extra,
});
const request = (payload = body(), headers = {}) => new Request('https://incident.example/alerts', {
  method: 'POST', body: payload, headers: { Authorization: `Bearer ${relayToken}`,
    'X-Alert-Source': 'tsx-core', 'Content-Type': 'application/json', ...headers },
});

class FakeD1 {
  rows = new Map();
  failInsert = false;
  failDelivered = false;

  prepare(sql) {
    return {
      bind: (...values) => ({
        run: async () => this.write(sql, values),
        first: async () => this.read(sql, values),
      }),
    };
  }

  write(sql, values) {
    if (sql.startsWith('DELETE FROM incident_deliveries WHERE delivery_key =')) return this.deleteExpired(values);
    if (sql.startsWith('INSERT OR IGNORE')) return this.insert(values);
    if (sql.startsWith("UPDATE incident_deliveries SET state = 'pending'")) return this.acquireRetry(values);
    if (sql.startsWith("UPDATE incident_deliveries SET state = 'delivered'")) return this.delivered(values);
    if (sql.startsWith("UPDATE incident_deliveries SET state = 'retryable'")) return this.retryable(values);
    if (sql.startsWith("UPDATE incident_deliveries SET state = 'unknown'")) return this.unknown(values);
    if (sql.startsWith('DELETE FROM incident_deliveries WHERE delivery_key IN')) return this.cleanup(values);
    throw new Error(`Unexpected D1 write: ${sql}`);
  }

  read(sql, values) {
    if (!sql.startsWith('SELECT state FROM incident_deliveries')) throw new Error('Unexpected D1 read');
    const row = this.rows.get(values[0]);
    return row ? { state: row.state } : null;
  }

  deleteExpired([key, now]) {
    const row = this.rows.get(key);
    if (row?.state !== 'delivered' || row.expiresAt > now) return result(0);
    this.rows.delete(key);
    return result(1);
  }

  insert([key, createdAt, updatedAt, expiresAt]) {
    if (this.failInsert) throw new Error('D1 unavailable');
    if (this.rows.has(key)) return result(0);
    this.rows.set(key, { state: 'pending', createdAt, updatedAt, expiresAt, retryAfter: 0 });
    return result(1);
  }

  acquireRetry([now, key]) {
    const row = this.rows.get(key);
    if (row?.state !== 'retryable' || row.retryAfter > now) return result(0);
    row.state = 'pending'; row.updatedAt = now;
    return result(1);
  }

  delivered([now, expiresAt, messageId, key]) {
    if (this.failDelivered) throw new Error('D1 finalize unavailable');
    const row = this.rows.get(key);
    if (row?.state !== 'pending') return result(0);
    row.state = 'delivered'; row.updatedAt = now; row.expiresAt = expiresAt; row.messageId = messageId;
    return result(1);
  }

  retryable([now, retryAfter, key]) {
    const row = this.rows.get(key);
    if (row?.state !== 'pending') return result(0);
    row.state = 'retryable'; row.updatedAt = now; row.retryAfter = retryAfter;
    return result(1);
  }

  unknown([now, key]) {
    const row = this.rows.get(key);
    if (row?.state !== 'pending') return result(0);
    row.state = 'unknown'; row.updatedAt = now;
    return result(1);
  }

  cleanup([now]) {
    let changes = 0;
    for (const [key, row] of this.rows) {
      if (changes >= 1000) break;
      if (row.state === 'delivered' && row.expiresAt <= now) { this.rows.delete(key); changes += 1; }
    }
    return result(changes);
  }
}
function result(changes) { return { success: true, meta: { changes } }; }
function env(db = new FakeD1()) { return { RELAY_TOKEN: relayToken, DEDUPE_SECRET: dedupeSecret,
  TELEGRAM_BOT_TOKEN: botToken, TELEGRAM_CHAT_ID: chatId, DB: db }; }
function success(messageId = 42) { return new Response(JSON.stringify({ ok: true, result: { message_id: messageId } }),
  { status: 200, headers: { 'Content-Type': 'application/json' } }); }

const db = new FakeD1();
const settings = env(db);
const sends = [];
let nowMs = 1_700_000_000_000;
const offlineFetch = async (url, options) => { sends.push({ url, options }); return success(sends.length); };
const invoke = (req, bindings = settings, fetchImpl = offlineFetch) => handleIncidentRequest(req, bindings,
  { fetchImpl, now: () => nowMs });

assert.equal((await invoke(new Request('https://incident.example/healthz'), {})).status, 200);
let response = await invoke(request());
assert.equal(response.status, 202);
assert.equal(sends.length, 1);
assert.equal(sends[0].url, `https://api.telegram.org/bot${botToken}/sendMessage`);
const outgoing = JSON.parse(sends[0].options.body);
assert.equal(outgoing.chat_id, chatId);
assert.match(outgoing.text, /FIRING/u);
assert.match(outgoing.text, /correlation_id=single_-1001_42/u);
assert.doesNotMatch(outgoing.text, /PRIVATE ALERT BODY/u);
assert.equal(Object.hasOwn(outgoing, 'parse_mode'), false);
assert.equal((await invoke(request())).status, 202);
assert.equal(sends.length, 1, 'a delivered replay must not send twice');
assert.equal((await invoke(request(body('resolved')))).status, 202);
assert.match(JSON.parse(sends[1].options.body).text, /RESOLVED/u);
assert.equal(sends.length, 2);

for (const [req, expected] of [
  [request(body(), { Authorization: 'Bearer wrong' }), 401],
  [request(body(), { 'X-Alert-Source': 'foreign' }), 403],
  [request(body(), { 'Content-Type': 'text/plain' }), 415],
  [request('{bad json'), 400],
  [request(body('firing', { truncatedAlerts: 1 })), 400],
  [request(JSON.stringify({ status: 'firing', alerts: [] })), 400],
  [request(JSON.stringify({ status: 'firing', alerts: Array.from({ length: 21 }, () =>
    ({ labels: { alertname: 'TooMany', severity: 'high' } })) })), 400],
  [request(JSON.stringify({ status: 'firing', alerts: [{ labels: { alertname: 'Bad\nName', severity: 'critical' } }] })), 400],
  [request(JSON.stringify({ status: 'firing', alerts: [{ labels: {
    alertname: 'Bad', severity: 'critical', correlation_id: 'leak\nsecond-line' } }] })), 400],
  [request('x'.repeat(64 * 1024 + 1)), 413],
]) {
  assert.equal((await invoke(req)).status, expected);
}
const oversizedStream = new ReadableStream({
  start(controller) { controller.enqueue(new Uint8Array(64 * 1024 + 1)); controller.close(); },
});
const streamedRequest = new Request('https://incident.example/alerts', {
  method: 'POST', body: oversizedStream, duplex: 'half',
  headers: { Authorization: `Bearer ${relayToken}`, 'X-Alert-Source': 'tsx-core',
    'Content-Type': 'application/json' },
});
assert.equal((await invoke(streamedRequest)).status, 413, 'streaming cap must work without Content-Length');
assert.equal(sends.length, 2, 'invalid requests must never reach Telegram');

const unavailable = new FakeD1();
unavailable.failInsert = true;
assert.equal((await invoke(request(body('firing', { groupKey: 'db-down' })), env(unavailable))).status, 503);
assert.equal(sends.length, 2, 'ledger failure must precede delivery');

const unknown = new FakeD1();
let attempted = 0;
const networkFailure = async () => { attempted += 1; throw new Error(`hidden token ${botToken}`); };
const unknownPayload = body('firing', { groupKey: 'unknown-send' });
response = await invoke(request(unknownPayload), env(unknown), networkFailure);
assert.equal(response.status, 503);
assert.equal(await response.text(), '');
assert.equal((await invoke(request(unknownPayload), env(unknown), networkFailure)).status, 503);
assert.equal(attempted, 1, 'uncertain outcome must block automatic resend');
assert.equal([...unknown.rows.values()][0].state, 'unknown');

const malformedReply = new FakeD1();
let malformedCalls = 0;
const malformedFetch = async () => { malformedCalls += 1; return new Response('{bad', { status: 200 }); };
const malformedPayload = body('firing', { groupKey: 'malformed-telegram-reply' });
assert.equal((await invoke(request(malformedPayload), env(malformedReply), malformedFetch)).status, 503);
assert.equal((await invoke(request(malformedPayload), env(malformedReply), malformedFetch)).status, 503);
assert.equal(malformedCalls, 1);

const lostCommit = new FakeD1();
lostCommit.failDelivered = true;
let committedSends = 0;
const committedFetch = async () => { committedSends += 1; return success(); };
const commitPayload = body('firing', { groupKey: 'lost-commit' });
assert.equal((await invoke(request(commitPayload), env(lostCommit), committedFetch)).status, 503);
assert.equal((await invoke(request(commitPayload), env(lostCommit), committedFetch)).status, 503);
assert.equal(committedSends, 1, 'post-send ledger failure must not cause a second send');
assert.equal([...lostCommit.rows.values()][0].state, 'pending');

const retry = new FakeD1();
let retryCalls = 0;
const retryFetch = async () => {
  retryCalls += 1;
  return retryCalls === 1
    ? new Response(JSON.stringify({ ok: false, parameters: { retry_after: 3 } }), { status: 429 })
    : success(77);
};
const retryPayload = body('firing', { groupKey: 'rate-limited' });
assert.equal((await invoke(request(retryPayload), env(retry), retryFetch)).status, 503);
assert.equal((await invoke(request(retryPayload), env(retry), retryFetch)).status, 503);
assert.equal(retryCalls, 1);
nowMs += 3_000;
assert.equal((await invoke(request(retryPayload), env(retry), retryFetch)).status, 202);
assert.equal(retryCalls, 2);

const longRetry = new FakeD1();
let longRetryAt = nowMs;
let longRetryCalls = 0;
const longRetryFetch = async () => {
  longRetryCalls += 1;
  return longRetryCalls === 1
    ? new Response(JSON.stringify({ ok: false, parameters: { retry_after: 1800 } }), { status: 429 })
    : success(78);
};
const longPayload = body('firing', { groupKey: 'long-rate-limit' });
const invokeLong = () => handleIncidentRequest(request(longPayload), env(longRetry),
  { fetchImpl: longRetryFetch, now: () => longRetryAt });
assert.equal((await invokeLong()).status, 503);
longRetryAt += 1800 * 1000;
assert.equal((await invokeLong()).status, 202);
assert.equal((await invokeLong()).status, 202);
assert.equal(longRetryCalls, 2, 'dedupe window must start after a delayed successful send');

const racing = new FakeD1();
let release;
let racingSends = 0;
const heldFetch = async () => { racingSends += 1; await new Promise(resolve => { release = resolve; }); return success(); };
const racePayload = body('firing', { groupKey: 'concurrent' });
const first = invoke(request(racePayload), env(racing), heldFetch);
while (!release) await new Promise(resolve => setTimeout(resolve, 0));
assert.equal((await invoke(request(racePayload), env(racing), heldFetch)).status, 503);
release();
assert.equal((await first).status, 202);
assert.equal((await invoke(request(racePayload), env(racing), heldFetch)).status, 202);
assert.equal(racingSends, 1);

nowMs += 20 * 60 * 1000;
assert.equal((await invoke(request(), settings)).status, 202);
assert.equal(sends.length, 3, 'identical firing notification may repeat after dedupe window');
await incidentWorker.scheduled(null, settings);
assert.equal([...db.rows.values()].every(row => row.state !== 'delivered' || row.expiresAt > nowMs), true);

console.log('External incident receiver offline contract tests passed.');
