import assert from 'node:assert/strict';
import { extractMessageText, parseChatId } from '../scripts/run_staging_e2e.js';

assert.equal(parseChatId('-1001234567890', 'CHAT'), -1001234567890);
assert.throws(() => parseChatId('not-a-chat', 'CHAT'), /non-zero safe integer/);
assert.throws(() => parseChatId('0', 'CHAT'), /non-zero safe integer/);
assert.equal(extractMessageText({ content: { text: { text: 'plain' } } }), 'plain');
assert.equal(extractMessageText({ content: { caption: { text: 'caption' } } }), 'caption');
assert.equal(extractMessageText({}), '');

console.log('Staging E2E contract tests passed.');
