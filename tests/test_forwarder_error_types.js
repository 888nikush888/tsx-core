import assert from 'node:assert/strict';
import { TDLibError } from 'tdl';
import { forwarderErrorCode, isForwardRestrictedError } from '../src/forwarder_errors.js';
import { unknownErrorMessage } from '../src/contract_values.js';

for (const message of ['CHAT_FORWARDS_RESTRICTED', 'MESSAGE_COPY_FORBIDDEN', 'CONTENT_RESTRICTED']) {
  const error = new TDLibError(400, message);
  assert.equal(isForwardRestrictedError(error), true);
  assert.equal(isForwardRestrictedError(message), true);
  assert.equal(forwarderErrorCode(error), 400);
  assert.equal(unknownErrorMessage(error), message);
}
assert.equal(isForwardRestrictedError(new TDLibError(500, 'INTERNAL_ERROR')), false);
assert.equal(forwarderErrorCode(Object.assign(new Error('File missing'), { code: 'ENOENT' })), 'ENOENT');
let coercions = 0;
const objectCode = { toString() { coercions += 1; return 'ENOENT'; } };
const unexpected = { code: objectCode, message: 'CONTENT_RESTRICTED', toString() { coercions += 1; return 'CONTENT_RESTRICTED'; } };
assert.equal(forwarderErrorCode(unexpected));
assert.equal(isForwardRestrictedError(unexpected), false);
assert.match(unknownErrorMessage(unexpected), /non-Error value/);
assert.equal(coercions, 0, 'Unexpected objects cannot trigger error-code/restriction behavior by coercion.');
for (const value of [null, undefined, 0, false]) {
  assert.equal(forwarderErrorCode(value));
  assert.equal(isForwardRestrictedError(value), false);
}
console.log('Native TDLib, filesystem and unexpected forwarding error contracts passed.');
