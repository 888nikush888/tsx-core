import assert from 'node:assert';
import http from 'node:http';
import { once } from 'node:events';

import { TelegramBotApiClient, TelegramViewerCoreApiClient } from '../src/telegram_viewer/clients.js';
import { startTelegramViewerHealthServer } from '../src/telegram_viewer/health_server.js';

const SERVICE_TOKEN = 's'.repeat(43);

async function close(server) {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function run() {
  const requests = [];
  const upstream = http.createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
    response.setHeader('Content-Type', 'application/json');
    if (request.url.startsWith('/internal/viewer/v1/')) {
      assert.strictEqual(request.method, 'GET');
      assert.strictEqual(request.headers.authorization, `Bearer ${SERVICE_TOKEN}`);
      response.end(JSON.stringify(request.url.includes('/config')
        ? { settings: { enabled: false } }
        : { events: [], nextSeq: 0 }));
      return;
    }
    if (request.url.includes('/getUpdates')) response.end(JSON.stringify({ ok: true, result: [{ update_id: 1 }] }));
    else response.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress === 'object');
  const upstreamUrl = `http://127.0.0.1:${upstreamAddress.port}`;
  try {
    const core = new TelegramViewerCoreApiClient(upstreamUrl, SERVICE_TOKEN);
    await core.config();
    await core.get('events', { afterSeq: 0, limit: 10 });
    const bot = new TelegramBotApiClient('123456789:abcdefghijklmnopqrstuvwxyzABCDE', `${upstreamUrl}/bot`);
    assert.strictEqual((await bot.getUpdates(0)).length, 1);
    await bot.sendMessage('1001', 'hello', { reply_markup: { inline_keyboard: [] } });
    await bot.answerCallbackQuery('callback');
    assert.ok(requests.every(request => request.method === 'GET' || request.url.includes('/bot')));
    assert.ok(requests.every(request => !request.url.includes('setWebhook')), 'Viewer must use long polling, never webhooks');

    const health = startTelegramViewerHealthServer({
      host: '127.0.0.1', port: 0, serviceToken: SERVICE_TOKEN,
      status: () => ({ healthy: true, ready: true, enabled: false, lastError: null }),
    });
    await once(health, 'listening');
    const address = health.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    let response = await fetch(`${base}/health`);
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(await response.json(), { healthy: true });
    response = await fetch(`${base}/ready`);
    assert.strictEqual(response.status, 200);
    response = await fetch(`${base}/status`);
    assert.strictEqual(response.status, 401);
    response = await fetch(`${base}/status`, { headers: { Authorization: `Bearer ${SERVICE_TOKEN}` } });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(JSON.stringify(await response.json()).includes(SERVICE_TOKEN), false);
    response = await fetch(`${base}/health`, { method: 'POST' });
    assert.strictEqual(response.status, 405);
    await close(health);
    console.log('TELEGRAM VIEWER RUNTIME TESTS PASSED');
  } finally {
    await close(upstream);
  }
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
