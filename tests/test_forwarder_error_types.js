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
assert.equal(forwarderErrorCode(unexpected), undefined);
assert.equal(isForwardRestrictedError(unexpected), false);
assert.match(unknownErrorMessage(unexpected), /non-Error value/);
assert.equal(coercions, 0, 'Unexpected objects cannot trigger error-code/restriction behavior by coercion.');
for (const value of [null, undefined, 0, false]) {
  assert.equal(forwarderErrorCode(value), undefined);
  assert.equal(isForwardRestrictedError(value), false);
}
console.log('Native TDLib, filesystem and unexpected forwarding error contracts passed.');

import { readFile } from 'node:fs/promises';
import ts from 'typescript';

async function verifyRawForwardingPolicy(source) {
  const parsed = ts.createSourceFile('forwarder.ts', source, ts.ScriptTarget.Latest, true);
  const names = ['forwardSingleMessage', 'processSingleXml', 'telegramForwardingEnabled'];
  const functions = parsed.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
  assert.equal(functions.length, names.length, 'Exercise the actual forwarding decision functions.');
  const executable = ts.transpileModule(functions.map(node => node.getText(parsed)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  let rawCalls = 0;
  let parsingCalls = 0;
  let authorized = true;
  let xmlResult = { handled: false };
  const forward = new Function('getMessageTextAndType', 'externalParsingAuthorized', 'processXmlSignal', 'forwardRawMessage',
    `${executable}\nreturn forwardSingleMessage;`)(
    message => ({ text: message.text, type: 'text' }),
    () => authorized,
    async () => { parsingCalls += 1; return xmlResult; },
    async () => { rawCalls += 1; return 'raw-result'; },
  );
  const context = { signal: new AbortController().signal };
  for (const workflowRevisionId of [null, 'workflow-1']) {
    for (const text of [undefined, '', '  \t\n']) {
      for (const forwardToTarget of [false, true, undefined]) {
        const config = { durableIngress: { workflowRevisionId }, forwardOptions: { forwardToTarget } };
        rawCalls = 0;
        parsingCalls = 0;
        if (forwardToTarget === false) {
          await assert.rejects(forward({ id: 1, text }, config, context), /no configured side effect/);
          assert.equal(rawCalls, 0, 'An active workflow alone cannot authorize forwarding an unparsed message.');
        } else {
          assert.equal(await forward({ id: 1, text }, config, context), 'raw-result');
          assert.equal(rawCalls, 1);
        }
        assert.equal(parsingCalls, 0);
      }
    }
  }
  const config = { durableIngress: { workflowRevisionId: 'workflow-1' }, forwardOptions: { forwardToTarget: false } };
  xmlResult = { handled: false, workflowOriginal: true };
  assert.equal(await forward({ id: 2, text: 'original' }, config, context), 'raw-result');
  xmlResult = { handled: true, result: 'workflow-result' };
  rawCalls = 0;
  assert.equal(await forward({ id: 3, text: 'handled' }, config, context), 'workflow-result');
  assert.equal(rawCalls, 0);
  xmlResult = { handled: false };
  await assert.rejects(forward({ id: 4, text: 'unhandled' }, config, context), /no configured side effect/);
  authorized = false;
  await assert.rejects(forward({ id: 5, text: 'blocked' }, config, context), /external data-processing policy/);
  assert.equal(rawCalls, 0);
}


await verifyRawForwardingPolicy(await readFile(new URL('../src/forwarder.ts', import.meta.url), 'utf8'));
console.log('Workflow and raw forwarding authorization contracts passed.');

async function verifyLegacyMediaMigration(source) {
  const parsed = ts.createSourceFile('forwarder.ts', source, ts.ScriptTarget.Latest, true);
  const names = ['legacyMediaChatId', 'migrateLegacyMediaGroupBuffer'];
  const functions = parsed.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
  assert.equal(functions.length, names.length, 'Exercise the actual migration and ID validation functions.');
  const executable = ts.transpileModule(functions.map(node => node.getText(parsed)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  function fixture(data, saveError, readError) {
    const events = [];
    const fs = {
      async readFile() {
        if (readError) throw readError;
        return JSON.stringify(data);
      },
      async unlink() { events.push(['unlink']); },
    };
    const save = async (groupId, chatId, messages) => {
      events.push(['save', groupId, chatId, messages]);
      await Promise.resolve();
      if (saveError) throw saveError;
      events.push(['saved', groupId]);
    };
    const functions = new Function('fsPromises', 'LEGACY_MEDIA_BUFFER_FILE', 'saveMediaGroupBuffer', 'addLog',
      'forwarderErrorCode', 'unknownErrorMessage', executable + '\nreturn { migrate: migrateLegacyMediaGroupBuffer, chatId: legacyMediaChatId };')(
      fs, 'fixture-only.json', save, () => {}, forwarderErrorCode, unknownErrorMessage);
    return { ...functions, events };
  }
  const validIds = [-100123, 0, 123, Number.MAX_SAFE_INTEGER, '-100123', '001', '', ' 123 '];
  const valid = fixture(Object.fromEntries(validIds.map((fromChatId, index) => [`group-${index}`, { fromChatId, messages: [{ id: index }] }])));
  await valid.migrate();
  assert.deepEqual(valid.events, validIds.flatMap((id, index) => [
    ['save', `group-${index}`, String(id), [{ id: index }]], ['saved', `group-${index}`],
  ]).concat([['unlink']]));
  for (const fromChatId of [{}, [], null, undefined, true, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
    const invalid = fixture({ bad: { fromChatId, messages: [{ id: 1 }] } });
    await assert.rejects(invalid.migrate(), error => {
      assert.match(error.message, /Legacy media-buffer migration failed/);
      assert.match(error.cause.message, /source chat ID is invalid/);
      return true;
    });
    assert.deepEqual(invalid.events, [], 'Invalid IDs cannot be saved or delete the legacy file.');
  }
  let coerced = false;
  const hostile = { [Symbol.toPrimitive]() { coerced = true; return '123'; } };
  assert.throws(() => valid.chatId(hostile), /source chat ID is invalid/);
  assert.equal(coerced, false);
  for (const nonJsonId of [NaN, Infinity, -Infinity, 1n, Symbol('chat')]) {
    assert.throws(() => valid.chatId(nonJsonId), /source chat ID is invalid/);
  }
  const partial = fixture({ first: { fromChatId: 1, messages: [1] }, second: { messages: [2] } });
  await assert.rejects(partial.migrate(), /source chat ID is invalid/);
  assert.deepEqual(partial.events, [['save', 'first', '1', [1]], ['saved', 'first']],
    'A later invalid group retains the file; earlier sequential writes are not rolled back.');
  const saveError = new Error('fixture SQLite failure');
  const failedSave = fixture({ first: { fromChatId: 1, messages: [1] } }, saveError);
  await assert.rejects(failedSave.migrate(), error => error.cause === saveError);
  assert.deepEqual(failedSave.events, [['save', 'first', '1', [1]]]);
  const missing = fixture(undefined, undefined, Object.assign(new Error('missing fixture'), { code: 'ENOENT' }));
  await missing.migrate();
  assert.deepEqual(missing.events, []);
}

await verifyLegacyMediaMigration(await readFile(new URL('../src/forwarder.ts', import.meta.url), 'utf8'));
console.log('Legacy media migration scalar IDs, retained files and sequential writes passed.');
