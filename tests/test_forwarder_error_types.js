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
