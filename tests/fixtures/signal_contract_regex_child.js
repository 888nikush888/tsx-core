import assert from 'node:assert/strict';
import { BUILTIN_SIGNAL_CONTRACTS, validateSignalContractDefinition } from '../../src/signal_contract.js';
import { SignalValidationError, validateSignalXml } from '../../src/signal_schema.js';

const definition = structuredClone(BUILTIN_SIGNAL_CONTRACTS.find(contract => contract.id === 'standard').definition);
const precedingFields = process.argv[3] === 'late' ? 29 : 0;
definition.additionalFields = [
  ...Array.from({ length: precedingFields }, (_, index) => ({ path: `note_${index}`, type: 'text', required: true, allowedValues: [], pattern: '^a$' })),
  { path: 'note', type: 'text', required: true, allowedValues: [], pattern: process.argv[2] },
];
const contractDefinition = validateSignalContractDefinition(definition);
process.stdout.write('contract-validated\n');
if (process.argv[3] !== 'validate-only') {
  const xml = `<signal><action>LONG</action><pair>BTCUSD</pair>
  <entry_range><min>100</min><max>101</max></entry_range>
  <targets><target id="1">110</target></targets><stoploss>90</stoploss>
  ${Array.from({ length: precedingFields }, (_, index) => `<note_${index}>a</note_${index}>`).join('')}
  <note>${'a'.repeat(50)}!</note></signal>`;
  assert.throws(() => validateSignalXml(xml, undefined, {
    id: 'bounded-pattern', parserSchema: 'standard', contractDefinition,
  }), error => {
    assert.ok(error instanceof SignalValidationError);
    assert.match(error.message, /Contract path 'note'.*pattern.*budget/u);
    let cause = error.cause;
    while (cause?.cause) cause = cause.cause;
    assert.equal(cause?.code, 'ERR_SCRIPT_EXECUTION_TIMEOUT', 'Real VM timeout cause must remain inspectable.');
    return true;
  });
  process.stdout.write('bounded-pattern-rejected\n');
}
