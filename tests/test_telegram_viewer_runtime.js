import assert from 'node:assert';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { TelegramBotApiClient, TelegramViewerCoreApiClient } from '../src/telegram_viewer/clients.js';
import { startTelegramViewerHealthServer } from '../src/telegram_viewer/health_server.js';
import { delay, readRuntimeSecret, resilientLoop } from '../src/telegram_viewer/runtime.js';

const SERVICE_TOKEN = 's'.repeat(43);

async function close(server) {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function run() {
  const secretRoot = await mkdtemp(path.join(os.tmpdir(), 'tsx-viewer-runtime-secrets-'));
  const requests = [];
  let responseMode = 'ok';
  const upstream = http.createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
    response.setHeader('Content-Type', 'application/json');
    if (responseMode === 'malformed') {
      responseMode = 'ok';
      response.end('{not-json');
      return;
    }
    if (responseMode === 'unavailable') {
      responseMode = 'ok';
      response.statusCode = 503;
      response.end(JSON.stringify({ error: 'temporarily unavailable' }));
      return;
    }
    if (responseMode === 'telegram-rejected') {
      responseMode = 'ok';
      response.end(JSON.stringify({ ok: false, description: 'rejected' }));
      return;
    }
    if (responseMode === 'telegram-non-array') {
      responseMode = 'ok';
      response.end(JSON.stringify({ ok: true, result: {} }));
      return;
    }
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
    await writeFile(path.join(secretRoot, 'viewer_service_token'), SERVICE_TOKEN, 'utf8');
    assert.strictEqual(
      await readRuntimeSecret(secretRoot, 'viewer_service_token', /^[A-Za-z0-9_-]{43}$/),
      SERVICE_TOKEN,
    );
    await assert.rejects(
      readRuntimeSecret(path.join(secretRoot, 'viewer_service_token'), 'nested', /^[A-Za-z0-9_-]{20,}$/),
      /secret mount/i,
    );
    await writeFile(path.join(secretRoot, 'invalid'), 'contains whitespace', 'utf8');
    await assert.rejects(
      readRuntimeSecret(secretRoot, 'invalid', /^[A-Za-z0-9_-]{20,}$/),
      /secret value/i,
    );
    await mkdir(path.join(secretRoot, 'directory-secret'));
    await assert.rejects(
      readRuntimeSecret(secretRoot, 'directory-secret', /^[A-Za-z0-9_-]{20,}$/),
      /secret file/i,
    );
    try {
      await symlink(path.join(secretRoot, 'viewer_service_token'), path.join(secretRoot, 'linked-secret'));
      await assert.rejects(
        readRuntimeSecret(secretRoot, 'linked-secret', /^[A-Za-z0-9_-]{20,}$/),
        /secret file/i,
      );
    } catch (error) {
      if (error?.code !== 'EPERM') throw error;
    }
    await delay(0);
    const loopState = { healthy: 0, failures: [] };
    const loopService = {
      recordHealthyPoll() { loopState.healthy += 1; },
      recordFailure(error) { loopState.failures.push(error); },
    };
    await resilientLoop(async () => undefined, () => 250, loopService, 1);
    await resilientLoop(async () => undefined, () => 0, loopService, 2);
    await resilientLoop(async () => { throw new Error('short failure'); }, () => 250, loopService, 1);
    await resilientLoop(async () => { throw 'non-error failure'; }, () => 250, loopService, 1);
    assert.strictEqual(loopState.healthy, 3);
    assert.strictEqual(loopState.failures.length, 2);
    const core = new TelegramViewerCoreApiClient(upstreamUrl, SERVICE_TOKEN);
    await core.config();
    await core.get('events', { afterSeq: 0, limit: 10 });
    assert.throws(() => new TelegramViewerCoreApiClient('file:///tmp/viewer', SERVICE_TOKEN), /url is invalid/i);
    await assert.rejects(core.get('delete-everything'), /resource is not allowed/i);
    await assert.rejects(new TelegramViewerCoreApiClient(upstreamUrl, '').config(), /credential is unavailable/i);
    responseMode = 'malformed';
    await assert.rejects(core.config(), /malformed json/i);
    responseMode = 'unavailable';
    await assert.rejects(core.config(), /status 503/i);
    let activeBotToken = '123456789:abcdefghijklmnopqrstuvwxyzABCDE';
    const bot = new TelegramBotApiClient(() => activeBotToken, `${upstreamUrl}/bot`);
    assert.throws(() => new TelegramBotApiClient('invalid'), /bot token is invalid/i);
    assert.throws(
      () => new TelegramBotApiClient('123456789:abcdefghijklmnopqrstuvwxyzABCDE', 'file:///tmp/bot'),
      /api url is invalid/i,
    );
    assert.strictEqual((await bot.getUpdates(0)).length, 1);
    responseMode = 'telegram-non-array';
    assert.deepStrictEqual(await bot.getUpdates(0), []);
    activeBotToken = '987654321:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde';
    await bot.sendMessage('1001', 'hello', { reply_markup: { inline_keyboard: [] } });
    await bot.answerCallbackQuery('callback');
    await bot.answerCallbackQuery('callback-with-text', 'acknowledged');
    await assert.rejects(bot.call('deleteWebhook', {}), /method is not allowed/i);
    responseMode = 'telegram-rejected';
    await assert.rejects(bot.sendMessage('1001', 'rejected'), /rejected the request/i);
    activeBotToken = 'x'.repeat(25);
    await assert.rejects(bot.getUpdates(0), /bot token is invalid/i);
    activeBotToken = '987654321:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde';
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
    let response = await fetch(`${base}/healthz`);
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(await response.json(), { healthy: true });
    response = await fetch(`${base}/readyz`);
    assert.strictEqual(response.status, 200);
    response = await fetch(`${base}/status`);
    assert.strictEqual(response.status, 401);
    response = await fetch(`${base}/status`, { headers: { Authorization: `Bearer ${SERVICE_TOKEN}` } });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(JSON.stringify(await response.json()).includes(SERVICE_TOKEN), false);
    response = await fetch(`${base}/healthz`, { method: 'POST' });
    assert.strictEqual(response.status, 405);
    assert.ok(
      requests.some(request => request.url.includes(activeBotToken)),
      'The Bot API client must re-read a rotated bot token without restarting the viewer.',
    );
    await close(health);
    console.log('TELEGRAM VIEWER RUNTIME TESTS PASSED');
  } finally {
    await close(upstream);
    await rm(secretRoot, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
