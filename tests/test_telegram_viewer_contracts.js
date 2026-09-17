// skipcq: JS-C1003 - the module namespace object is passed as a whole into verifyFormatterScalarBoundaries.
import * as scalarFormatters from '../src/telegram_viewer/formatters.js';
import { verifyFormatterScalarBoundaries } from './fixtures/formatter_scalar_cases.js';
import assert from 'node:assert/strict';
import { TelegramBotApiClient, TelegramViewerCoreApiClient } from '../src/telegram_viewer/clients.js';
import { TelegramViewerService } from '../src/telegram_viewer/service.js';
import { DEFAULT_TELEGRAM_VIEWER_SETTINGS } from '../src/telegram_viewer_settings.js';

const originalFetch = globalThis.fetch;
let payload = null;
globalThis.fetch = () => new Response(JSON.stringify(payload), { status: 200 });
try {
  const core = new TelegramViewerCoreApiClient('http://127.0.0.1:12345', 's'.repeat(43));
  const bot = new TelegramBotApiClient(`123456789:${'x'.repeat(30)}`, 'http://127.0.0.1:12345/bot');
  payload = null;
  await assert.rejects(core.get('summary'), /invalid object/);
  payload = { settings: { enabled: true } };
  await assert.rejects(core.config(), /missing setting/);
  payload = { settings: DEFAULT_TELEGRAM_VIEWER_SETTINGS };
  assert.deepEqual((await core.config()).settings, DEFAULT_TELEGRAM_VIEWER_SETTINGS);
  for (const id of [null, {}, '1', -1, 1.5]) {
    payload = { ok: true, result: [{ update_id: id }] };
    await assert.rejects(bot.getUpdates(0), /invalid update identity/);
  }
  payload = { ok: true, result: [{ update_id: 1, unexpected: { keptByUpstream: true } }] };
  assert.equal((await bot.getUpdates(0))[0].update_id, 1);
} finally { globalThis.fetch = originalFetch; }

const settings = { ...DEFAULT_TELEGRAM_VIEWER_SETTINGS, enabled: true, allowedUserIds: ['1001'] };
let queueCalls = 0, cursorWrites = 0, sends = 0, coercions = 0;
let response = { events: [], nextSeq: {} };
const state = {
  lastTest: () => null, eventCursor: () => 5, testCursor: () => 5,
  queueDeliveries: () => { queueCalls += 1; },
  setEventCursor: () => { cursorWrites += 1; }, setTestCursor: () => { cursorWrites += 1; },
  pendingDeliveries: () => [], telegramOffset: () => 0, setTelegramOffset: async () => { /* test double: offset writes are not asserted */ },
};
const viewer = new TelegramViewerService({
  core: { config: () => ({ settings }), get: () => response }, state,
  bot: {
    getUpdates: () => [{ update_id: 1, message: { chat: { id: '1001', type: 'private' },
      from: { id: { toString() { coercions += 1; return '1001'; } } }, text: '/status' } }],
    sendMessage: () => { sends += 1; }, answerCallbackQuery: async () => { /* test double: callback answers are not asserted */ },
  },
});
await viewer.refreshSettings();
await viewer.pollTelegramOnce();
assert.equal(coercions, 0, 'Object user identities must not acquire authorization through coercion.');
assert.equal(sends, 0);
for (const invalid of [{ events: [], nextSeq: {} }, { events: [], nextSeq: 4 },
  { events: [{ id: 'bad', seq: '6' }], nextSeq: 6 }]) {
  response = invalid;
  await assert.rejects(viewer.pollEventsOnce(), /invalid/);
  await assert.rejects(viewer.pollTestEventsOnce(), /invalid/);
}
assert.equal(queueCalls, 0);
assert.equal(cursorWrites, 0, 'Invalid responses must not lose unseen events by advancing a cursor.');
console.log('Viewer API contracts reject malformed identities/settings/cursors without delivery effects.');


verifyFormatterScalarBoundaries(scalarFormatters);
