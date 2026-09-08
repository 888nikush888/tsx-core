import assert from 'node:assert/strict';
import { BUILTIN_SIGNAL_CONTRACTS, validateSignalContractDefinition } from '../../src/signal_contract.js';
import { SignalValidationError, validateSignalXml } from '../../src/signal_schema.js';

const definition = structuredClone(BUILTIN_SIGNAL_CONTRACTS.find(contract => contract.id === 'standard').definition);
definition.additionalFields = [{ path: 'note', type: 'text', required: true, allowedValues: [], pattern: process.argv[2] }];
const contractDefinition = validateSignalContractDefinition(definition);
process.stdout.write('contract-validated\n');
const xml = `<signal><action>LONG</action><pair>BTCUSD</pair>
<entry_range><min>100</min><max>101</max></entry_range>
<targets><target id="1">110</target></targets><stoploss>90</stoploss>
<note>${'a'.repeat(50)}!</note></signal>`;
assert.throws(() => validateSignalXml(xml, undefined, {
  id: 'bounded-pattern', parserSchema: 'standard', contractDefinition,
}), error => error instanceof SignalValidationError && /pattern.*budget/u.test(error.message));
process.stdout.write('bounded-pattern-rejected\n');
