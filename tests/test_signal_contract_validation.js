import assert from 'node:assert/strict';
import {
  BUILTIN_SIGNAL_CONTRACTS,
  signalContractDefinitionSha256,
  validateSignalContractDefinition,
} from '../src/signal_contract.js';
import { validateSignalXml } from '../src/signal_schema.js';

const standard = () => structuredClone(
  BUILTIN_SIGNAL_CONTRACTS.find(contract => contract.id === 'standard').definition,
);

function rejects(mutator, pattern) {
  const definition = standard();
  mutator(definition);
  assert.throws(() => validateSignalContractDefinition(definition), pattern);
}

assert.match(signalContractDefinitionSha256(standard()), /^[a-f0-9]{64}$/);
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
rejects(value => { value.targets.minimumItems = 0; }, /between 1 and/);
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
const unboundedTargetsXml = `<signal>
<action>LONG</action><pair>BTCUSD</pair>
<entry_range><min>100</min><max>101</max></entry_range>
<targets>${Array.from({ length: 25 }, (_, index) => `<target id="${index + 1}">${110 + index}</target>`).join('')}</targets>
<stoploss>90</stoploss>
</signal>`;
const unboundedDefinition = validateSignalContractDefinition(standard());
assert.equal(validateSignalXml(unboundedTargetsXml, undefined, {
  id: 'validation-contract',
  parserSchema: 'standard',
  contractDefinition: unboundedDefinition,
}).execution.targets.length, 25);
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

const typedInvalidCases = [
  [marketXml.replace('MARKET', 'STOP'), /not allowed by the contract/],
  [marketXml.replace('<entry_type>MARKET</entry_type>', '<entry_type>LIMIT</entry_type>'), /appear exactly once/],
  [marketXml.replace('<entry_type>MARKET</entry_type>', '<entry_type>MARKET</entry_type><entry_range><min>100</min><max>101</max></entry_range>'), /must omit/],
  [marketXml.replace('<leverage>5</leverage>', '<leverage>126</leverage>'), /between 1 and 125/],
  [marketXml.replace('<risk>1.5</risk>', '<risk>101</risk>'), /must not exceed 100/],
  [marketXml.replace('<action>LONG</action>', '<action>HOLD</action>'), /LONG.*SHORT/],
  [marketXml.replace('<pair>ETHUSD</pair>', '<pair>ethusd</pair>'), /normalized uppercase trading symbol/],
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
  [shortRangeXml.replace('<target id="2"><min>80</min><max>81</max></target>', ''), /at least 2 items/],
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

console.log('Signal contract definition and dynamic-field validation tests passed.');
