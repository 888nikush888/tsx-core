import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  BUILTIN_SIGNAL_CONTRACTS,
  composeSignalSchemaContract,
  signalContractDefinitionSha256,
  validateSignalContractDefinition,
} from '../src/signal_contract.js';
import { assertSignalGrounded, validateSignalXml } from '../src/signal_schema.js';

const standard = () => structuredClone(
  BUILTIN_SIGNAL_CONTRACTS.find(contract => contract.id === 'standard').definition,
);

function rejects(mutator, pattern) {
  const definition = standard();
  mutator(definition);
  assert.throws(() => validateSignalContractDefinition(definition), pattern);
}

assert.match(signalContractDefinitionSha256(standard()), /^[a-f0-9]{64}$/);

const builderSchema = standard();
builderSchema.actionPath = 'direction';
builderSchema.pairPath = 'market';
builderSchema.stopLossPath = 'protective_stop';
builderSchema.targets = {
  ...builderSchema.targets,
  containerPath: 'take_profits',
  itemTag: 'price',
  minimumItems: 1,
  maximumItems: 20,
};
builderSchema.additionalFields = [
  {
    path: 'memo',
    type: 'text',
    required: false,
    allowedValues: [],
    maximumLength: 100,
  },
  {
    path: 'schema_only',
    type: 'text',
    required: false,
    allowedValues: [],
    maximumLength: 100,
  },
];
const connectedContract = standard();
connectedContract.targets = {
  ...connectedContract.targets,
  minimumItems: 1,
  maximumItems: 1,
};
connectedContract.geometry.orderedTargets = false;
connectedContract.additionalFields = [{
  path: 'memo',
  type: 'text',
  required: true,
  allowedValues: ['OK'],
  maximumLength: 2,
  pattern: '^OK$',
}];
const composed = composeSignalSchemaContract(builderSchema, connectedContract);
assert.equal(composed.actionPath, 'direction');
assert.equal(composed.pairPath, 'market');
assert.equal(composed.stopLossPath, 'protective_stop');
assert.equal(composed.targets.containerPath, 'take_profits');
assert.equal(composed.targets.maximumItems, 1);
assert.equal(composed.geometry.orderedTargets, false);
assert.equal(composed.additionalFields[0].path, 'memo');
assert.equal(composed.additionalFields[0].required, true);
assert.deepEqual(composed.additionalFields[0].allowedValues, ['OK']);
assert.equal(composed.additionalFields[0].maximumLength, 2);
assert.equal(composed.additionalFields[0].pattern, '^OK$');
assert.equal(composed.additionalFields[1].path, 'schema_only');
assert.equal(composed.additionalFields[1].required, false);
assert.equal(composed.additionalFields[1].maximumLength, 100);
const builderXml = `<signal>
<direction>LONG</direction><market>BTCUSD</market>
<entry_range><min>100</min><max>101</max></entry_range>
<take_profits><price id="1">110</price></take_profits><protective_stop>90</protective_stop><memo>OK</memo>
</signal>`;
assert.equal(validateSignalXml(builderXml, undefined, {
  id: 'builder-schema',
  parserSchema: 'standard',
  schemaDefinition: builderSchema,
  contractDefinition: connectedContract,
}).execution.symbol, 'BTCUSD');
assert.throws(() => validateSignalXml(
  builderXml.replace('</take_profits>', '<price id="2">120</price></take_profits>'),
  undefined,
  {
    id: 'builder-schema',
    parserSchema: 'standard',
    schemaDefinition: builderSchema,
    contractDefinition: connectedContract,
  },
), /between 1 and 1/);
assert.throws(() => validateSignalXml(
  builderXml.replace('<memo>OK</memo>', ''),
  undefined,
  {
    id: 'builder-schema',
    parserSchema: 'standard',
    schemaDefinition: builderSchema,
    contractDefinition: connectedContract,
  },
), /must appear exactly once/);
assert.throws(() => validateSignalContractDefinition(null), /must be an object/);
rejects(value => { value.unsupported = true; }, /unsupported fields/);
rejects(value => { value.schemaVersion = 2; }, /schema version/);
rejects(value => { value.rootTag = 'trade'; }, /rootTag/);
rejects(value => { value.additionalFields = null; }, /at most 30/);
rejects(value => { value.actionPath = 'Bad.Path'; }, /lowercase XML path/);
rejects(value => { value.pairPath = ''; }, /pairPath is invalid/);
rejects(value => { value.entry.extra = true; }, /entry contains unsupported fields/);
rejects(value => { value.entry.mode = 'invalid'; }, /entry.mode/);
rejects(value => {
  value.entry = {
    ...value.entry,
    mode: 'typed',
    typePath: undefined,
    marketValues: [],
    rangeValues: [],
  };
}, /Typed entries require/);
rejects(value => {
  value.entry.typePath = 'entry_type';
  value.entry.marketValues = ['MARKET'];
}, /Only typed entries/);
rejects(value => { value.entry.marketValues = 'MARKET'; }, /array of at most/);
rejects(value => {
  value.entry.mode = 'typed';
  value.entry.typePath = 'entry_type';
  value.entry.marketValues = ['MARKET', 'MARKET'];
  value.entry.rangeValues = ['LIMIT'];
}, /must not contain duplicates/);
rejects(value => { value.targets.shape = 'points'; }, /targets.shape/);
rejects(value => { value.targets.minimumItems = 0; }, /between 1 and 20/);
rejects(value => { value.targets.sequentialIds = 'yes'; }, /must be boolean/);
rejects(value => { value.stopLossPath = value.actionPath; }, /paths must be unique/);
rejects(value => { value.geometry.stopOnLossSide = 'yes'; }, /must be boolean/);

const fieldDefinition = standard();
fieldDefinition.additionalFields = [
  {
    path: 'note',
    type: 'text',
    required: true,
    allowedValues: ['A', 'AA', 'AAA'],
    maximumLength: 2,
    pattern: '^A$',
  },
  { path: 'enabled', type: 'boolean', required: true, allowedValues: [] },
  { path: 'count', type: 'integer', required: true, allowedValues: [] },
  {
    path: 'score',
    type: 'decimal',
    required: true,
    allowedValues: [],
    minimum: '1',
    maximum: '2',
  },
];
const validatedDefinition = validateSignalContractDefinition(fieldDefinition);
const xml = `<signal>
<action>LONG</action><pair>BTCUSD</pair>
<entry_range><min>100</min><max>101</max></entry_range>
<targets><target id="1">110</target></targets><stoploss>90</stoploss>
<note>A</note><enabled>true</enabled><count>2</count><score>1.5</score>
</signal>`;
const validatedSignal = validateSignalXml(xml, undefined, {
  id: 'validation-contract',
  parserSchema: 'standard',
  contractDefinition: validatedDefinition,
});
assert.deepEqual(validatedSignal.execution, {
  schema: 'validation-contract',
  action: 'LONG',
  symbol: 'BTCUSD',
  entry: { type: 'range', min: '100', max: '101' },
  targets: [{ min: '110', max: '110' }],
  stopLoss: '90',
  suggestedLeverage: undefined,
  suggestedRiskPercent: undefined,
  averagingPrice: undefined,
});
assert.deepEqual(validatedSignal.groundingNumbers, ['100', '101', '110', '110', '90']);
assert.deepEqual(validatedSignal.groundingFields, [
  { kind: 'entry', values: ['100', '101'] },
  { kind: 'target', values: ['110', '110'] },
  { kind: 'stop', values: ['90'] },
]);
assert.deepEqual(validatedSignal.groundingPolicy, { action: true, pair: true });

const invalidXmlCases = [
  [xml.replace('<note>A</note>', '<note>B</note>'), /unsupported value/],
  [xml.replace('<note>A</note>', '<note>AAA</note>'), /maximum length/],
  [xml.replace('<note>A</note>', '<note>AA</note>'), /required pattern/],
  [xml.replace('<enabled>true</enabled>', '<enabled>yes</enabled>'), /true or false/],
  [xml.replace('<count>2</count>', '<count>-1</count>'), /unsigned integer/],
  [xml.replace('<score>1.5</score>', '<score>0.5</score>'), /below its minimum/],
  [xml.replace('<score>1.5</score>', '<score>2.5</score>'), /exceeds its maximum/],
];
for (const [candidate, pattern] of invalidXmlCases) {
  assert.throws(() => validateSignalXml(candidate, undefined, {
    id: 'validation-contract',
    parserSchema: 'standard',
    contractDefinition: validatedDefinition,
  }), pattern);
}

const typedDefinition = standard();
typedDefinition.entry = {
  ...typedDefinition.entry,
  mode: 'typed',
  typePath: 'entry_type',
  marketValues: ['MARKET'],
  rangeValues: ['LIMIT'],
};
typedDefinition.riskPercentPath = 'risk';
typedDefinition.averagingPricePath = 'averaging';
const validatedTypedDefinition = validateSignalContractDefinition(typedDefinition);
const typedSelection = {
  id: 'typed-contract',
  parserSchema: 'standard',
  contractDefinition: validatedTypedDefinition,
};
const marketXml = `<signal>
<action>LONG</action><pair>ETHUSD</pair><entry_type>MARKET</entry_type>
<targets><target id="1">110</target><target id="2">120</target></targets>
<stoploss>90</stoploss><leverage>5</leverage><risk>1.5</risk><averaging>99</averaging>
</signal>`;
const marketSignal = validateSignalXml(marketXml, undefined, typedSelection);
assert.deepEqual(marketSignal.execution, {
  schema: 'typed-contract',
  action: 'LONG',
  symbol: 'ETHUSD',
  entry: { type: 'market' },
  targets: [{ min: '110', max: '110' }, { min: '120', max: '120' }],
  stopLoss: '90',
  suggestedLeverage: 5,
  suggestedRiskPercent: '1.5',
  averagingPrice: '99',
});
assert.deepEqual(marketSignal.groundingNumbers, ['110', '110', '120', '120', '90', '5', '1.5', '99']);
assert.deepEqual(marketSignal.groundingFields, [
  { kind: 'target', values: ['110', '110', '120', '120'] },
  { kind: 'stop', values: ['90'] },
  { kind: 'leverage', values: ['5'] },
  { kind: 'risk', values: ['1.5'] },
  { kind: 'averaging', values: ['99'] },
]);

const withoutLeverageXml = marketXml.replace('<leverage>5</leverage>', '');
assert.equal(validateSignalXml(withoutLeverageXml, undefined, typedSelection).execution.suggestedLeverage, undefined);
for (const leverage of ['1', '125']) {
  const accepted = marketXml.replace('<leverage>5</leverage>', `<leverage>${leverage}</leverage>`);
  assert.equal(validateSignalXml(accepted, undefined, typedSelection).execution.suggestedLeverage, Number(leverage));
}

const typedInvalidCases = [
  [marketXml.replace('MARKET', 'STOP'), /not allowed by the contract/],
  [marketXml.replace('<entry_type>MARKET</entry_type>', '<entry_type>LIMIT</entry_type>'), /appear exactly once/],
  [marketXml.replace('<entry_type>MARKET</entry_type>', '<entry_type>MARKET</entry_type><entry_range><min>100</min><max>101</max></entry_range>'), /must omit/],
  [marketXml.replace('<leverage>5</leverage>', '<leverage>126</leverage>'), /between 1 and 125/],
  [marketXml.replace('<leverage>5</leverage>', '<leverage>2.5</leverage>'), /integer between 1 and 125/],
  [marketXml.replace('<leverage>5</leverage>', '<leverage>0</leverage>'), /greater than zero|integer between 1 and 125/],
  [marketXml.replace('<leverage>5</leverage>', '<leverage>0.99</leverage>'), /between 1 and 125/],
  [marketXml.replace('<leverage>5</leverage>', '<leverage>125.01</leverage>'), /between 1 and 125/],
  [marketXml.replace('<risk>1.5</risk>', '<risk>101</risk>'), /must not exceed 100/],
  [marketXml.replace('<action>LONG</action>', '<action>HOLD</action>'), /LONG.*SHORT/],
  [marketXml.replace('<pair>ETHUSD</pair>', '<pair>ethusd</pair>'), /quote asset/],
  [marketXml.replace('<stoploss>90</stoploss>', '<stoploss>90</stoploss><stoploss>89</stoploss>'), /at most once/],
  [marketXml.replace('</signal>', '<unknown>1</unknown></signal>'), /Unknown tag/],
];
for (const [candidate, pattern] of typedInvalidCases) {
  assert.throws(() => validateSignalXml(candidate, undefined, typedSelection), pattern);
}

const rangeDefinition = standard();
rangeDefinition.targets = {
  ...rangeDefinition.targets,
  shape: 'range',
  minimumItems: 2,
  maximumItems: 2,
};
const rangeSelection = {
  id: 'range-contract',
  parserSchema: 'standard',
  contractDefinition: validateSignalContractDefinition(rangeDefinition),
};
const shortRangeXml = `<signal>
<action>SHORT</action><pair>BTCUSD</pair>
<entry_range><min>100</min><max>101</max></entry_range>
<targets>
  <target id="1"><min>90</min><max>91</max></target>
  <target id="2"><min>80</min><max>81</max></target>
</targets><stoploss>110</stoploss>
</signal>`;
assert.deepEqual(validateSignalXml(shortRangeXml, undefined, rangeSelection).execution.targets, [
  { min: '90', max: '91' },
  { min: '80', max: '81' },
]);
const invalidRangeCases = [
  [shortRangeXml.replace('<min>90</min><max>91</max>', '<min>92</min><max>91</max>'), /minimum must not exceed/],
  [shortRangeXml.replace('<min>80</min><max>81</max>', '<min>92</min><max>93</max>'), /strictly ordered/],
  [shortRangeXml.replace('<stoploss>110</stoploss>', '<stoploss>100</stoploss>'), /above the entry range/],
  [shortRangeXml.replace('<min>90</min><max>91</max>', '<min>101</min><max>102</max>'), /below entry/],
  [shortRangeXml.replace('<target id="2"><min>80</min><max>81</max></target>', ''), /between 2 and 2/],
  [shortRangeXml.replace('target id="2"', 'target id="3"'), /sequential/],
];
for (const [candidate, pattern] of invalidRangeCases) {
  assert.throws(() => validateSignalXml(candidate, undefined, rangeSelection), pattern);
}

const permissiveDefinition = structuredClone(validatedDefinition);
permissiveDefinition.geometry = {
  stopOnLossSide: false,
  targetsOnProfitSide: false,
  orderedTargets: false,
  orderedRanges: false,
};
permissiveDefinition.grounding = {
  action: false,
  pair: false,
  entry: false,
  targets: false,
  stopLoss: false,
  leverage: false,
  riskPercent: false,
  averagingPrice: false,
};
const permissiveXml = xml
  .replace('<targets><target id="1">110</target></targets>', '<targets><target id="1">95</target></targets>')
  .replace('<stoploss>90</stoploss>', '<stoploss>105</stoploss>');
const permissiveSignal = validateSignalXml(permissiveXml, undefined, {
  id: 'permissive-contract',
  parserSchema: 'standard',
  contractDefinition: validateSignalContractDefinition(permissiveDefinition),
});
assert.deepEqual(permissiveSignal.groundingNumbers, []);
assert.deepEqual(permissiveSignal.groundingFields, []);
assert.deepEqual(permissiveSignal.groundingPolicy, { action: false, pair: false });

rejects(value => { value.additionalFields = [null]; }, /must be an object/);
rejects(value => {
  value.additionalFields = [{ path: 'note', type: 'unknown', required: true, allowedValues: [] }];
}, /type is invalid/);
rejects(value => {
  value.additionalFields = [{
    path: 'score', type: 'decimal', required: true, allowedValues: [], minimum: '2', maximum: '1',
  }];
}, /minimum must not exceed/);
rejects(value => {
  value.additionalFields = [{ path: 'note', type: 'text', required: true, allowedValues: [], maximumLength: 0 }];
}, /maximumLength/);
rejects(value => {
  value.additionalFields = [{ path: 'note', type: 'text', required: true, allowedValues: [], pattern: 'a++' }];
}, /high-risk/);
rejects(value => {
  value.additionalFields = [{ path: 'note', type: 'text', required: true, allowedValues: [], pattern: '[' }];
}, /valid regular expression/);

function testNumericGroundingBoundaries() {
  const numberSignal = number => ({ groundingPolicy: { action: false, pair: false }, groundingNumbers: [number], groundingFields: [] });
  for (const [value, source] of [['0', '0'], ['0.000000000000000001', 'x0.000000000000000001%'],
    ['123456789012345678.123456789012345678', '123456789012345678.123456789012345678x'], ['10', 'x10']]) {
    assert.doesNotThrow(() => assertSignalGrounded(numberSignal(value), source));
  }
  for (const source of ['01', 'word1', '1word', '1.0000000000000000001', '1.1', '01.0', 'а1', '_1', '1.']) {
    if (source === '1.') assert.doesNotThrow(() => assertSignalGrounded(numberSignal('1'), source));
    else assert.throws(() => assertSignalGrounded(numberSignal('1'), source), /not grounded/);
  }
  for (const number of ['0', '0.5', '10.25']) {
    const signal = { ...numberSignal(number), groundingFields: [{ kind: 'risk', values: [number] }] };
    assert.doesNotThrow(() => assertSignalGrounded(signal, `НА ${number}% ДЕПОЗИТА`));
    assert.throws(() => assertSignalGrounded(signal, `НА ${number}% ДЕПОЗИТАХ`), /grounded/);
  }
}
testNumericGroundingBoundaries();
function testContractPatternExecution() {
  const definition = standard();
  const check = (pattern, value) => {
    definition.additionalFields = [{ path: 'note', type: 'text', required: true, allowedValues: [], pattern }];
    return validateSignalXml(`<signal><action>LONG</action><pair>BTCUSD</pair>
      <entry_range><min>100</min><max>101</max></entry_range>
      <targets><target id="1">110</target></targets><stoploss>90</stoploss><note>${value}</note></signal>`,
    undefined, { id: 'pattern-compatibility', parserSchema: 'standard', contractDefinition: definition });
  };
  for (const [pattern, value] of [
    ['^(ab+)+$', 'ababb'], ['^(?:BUY|SELL)-[0-9]{1,4}$', 'BUY-123'],
    [String.raw`^\p{L}+$`, 'ÄÖß'], [String.raw`^\(a\+\)\+$`, '(a+)+'],
  ]) assert.doesNotThrow(() => check(pattern, value));
  assert.throws(() => check('^BUY$', 'SELL'), /required pattern/);
  definition.additionalFields = Array.from({ length: 30 }, (_, index) => ({
    path: `note_${String.fromCodePoint(97 + Math.floor(index / 26), 97 + index % 26)}`,
    type: 'text', required: true, allowedValues: [], pattern: '^a$',
  }));
  const multiXml = `<signal><action>LONG</action><pair>BTCUSD</pair>
    <entry_range><min>100</min><max>101</max></entry_range>
    <targets><target id="1">110</target></targets><stoploss>90</stoploss>
    ${definition.additionalFields.map(field => `<${field.path}>a</${field.path}>`).join('')}</signal>`;
  const checkMultiple = () => validateSignalXml(multiXml, undefined, {
    id: 'shared-pattern-budget', parserSchema: 'standard', contractDefinition: definition,
  });
  assert.doesNotThrow(checkMultiple, 'All 30 ordinary field patterns must remain supported.');
  const originalPerformance = globalThis.performance;
  let elapsed = 0;
  try {
    // Advance time across individually cheap matches: the deadline must be
    // shared, not replenished for every additional field.
    globalThis.performance = { now: () => { elapsed += 4; return elapsed; } };
    assert.throws(checkMultiple, /pattern.*budget/u);
  } finally {
    globalThis.performance = originalPerformance;
  }

  // The outer process owns the deadline even if the runtime guard regresses.
  const fixture = fileURLToPath(new URL('./fixtures/signal_contract_regex_child.js', import.meta.url));
  for (const pattern of ['^(a+)+$', '^(a|aa)+$', '^((a+))+$']) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', fixture, pattern], {
      encoding: 'utf8', timeout: 5_000,
    });
    assert.equal(result.error, undefined, 'Untrusted pattern must not hang its subprocess.');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /bounded-pattern-rejected/u);
  }
}
testContractPatternExecution();
console.log('Signal contract definition and dynamic-field validation tests passed.');
