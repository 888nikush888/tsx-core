import { createHash } from 'node:crypto';
import { compareDecimal, decimal } from './trading_decimal.js';
import type {
  SignalContractAdditionalField,
  SignalContractDefinition,
  SignalContractEntryMode,
  SignalContractFieldType,
  SignalContractTargetShape,
} from './trading_types.js';

const PATH_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){0,3}$/;
const SAFE_PATTERN_LIMIT = 160;
const FIELD_TYPES = new Set<SignalContractFieldType>(['text', 'decimal', 'integer', 'boolean']);
const ENTRY_MODES = new Set<SignalContractEntryMode>(['optional_range', 'required_range', 'typed']);
const TARGET_SHAPES = new Set<SignalContractTargetShape>(['scalar', 'range']);
const UNSUPPORTED_LOOKAROUNDS = ['(?=', '(?!', '(?<=', '(?<!'] as const;
const NUMERIC_BACKREFERENCE_PATTERN = new RegExp(String.raw`\\[1-9]`, 'u');

function record(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, any>;
}

function exactKeys(value: Record<string, any>, label: string, keys: string[]): void {
  const extras = Object.keys(value).filter(key => !keys.includes(key));
  if (extras.length > 0) throw new Error(`${label} contains unsupported fields: ${extras.join(', ')}.`);
}

function text(value: unknown, label: string, maximum = 80): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum || /[\r\n\0]/.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value.trim();
}

function pathValue(value: unknown, label: string): string {
  const normalized = text(value, label, 96);
  if (!PATH_PATTERN.test(normalized)) {
    throw new Error(`${label} must contain one to four lowercase XML path segments.`);
  }
  return normalized;
}

function optionalPath(value: unknown, label: string): string | undefined {
  return value === undefined || value === null || value === '' ? undefined : pathValue(value, label);
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return Number(value);
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean.`);
  return value;
}

function strings(value: unknown, label: string, maximum = 20): string[] {
  if (!Array.isArray(value) || value.length > maximum || value.some(item => typeof item !== 'string')) {
    throw new Error(`${label} must be an array of at most ${maximum} strings.`);
  }
  const normalized = value.map(item => text(item, label, 80));
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label} must not contain duplicates.`);
  return normalized;
}

function hasUnsupportedPatternConstruct(pattern: string): boolean {
  return NUMERIC_BACKREFERENCE_PATTERN.test(pattern)
    || pattern.includes('\\k<')
    || UNSUPPORTED_LOOKAROUNDS.some(token => pattern.includes(token))
    || /[*+]\s*[*+{]/.test(pattern)
    || /\{\d+(?:,\d*)?\}\s*[*+{]/.test(pattern);
}

function safePattern(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const pattern = text(value, label, SAFE_PATTERN_LIMIT);
  if (hasUnsupportedPatternConstruct(pattern)) {
    throw new Error(`${label} contains unsupported high-risk regular-expression constructs.`);
  }
  try {
    new RegExp(pattern, 'u');
  } catch (error) {
    throw new Error(`${label} is not a valid regular expression.`, { cause: error });
  }
  return pattern;
}

function additionalField(value: unknown, index: number): SignalContractAdditionalField {
  const field = record(value, `additionalFields[${index}]`);
  exactKeys(field, `additionalFields[${index}]`, [
    'path', 'type', 'required', 'allowedValues', 'minimum', 'maximum', 'maximumLength', 'pattern',
  ]);
  if (!FIELD_TYPES.has(field.type)) throw new Error(`additionalFields[${index}].type is invalid.`);
  const minimum = field.minimum === undefined || field.minimum === '' ? undefined : decimal(String(field.minimum));
  const maximum = field.maximum === undefined || field.maximum === '' ? undefined : decimal(String(field.maximum));
  if (minimum !== undefined && maximum !== undefined && compareDecimal(minimum, maximum) > 0) {
    throw new Error(`additionalFields[${index}] minimum must not exceed maximum.`);
  }
  const maximumLength = field.maximumLength === undefined
    ? undefined
    : integer(field.maximumLength, `additionalFields[${index}].maximumLength`, 1, 2_000);
  const allowedValues = strings(field.allowedValues ?? [], `additionalFields[${index}].allowedValues`, 50);
  return {
    path: pathValue(field.path, `additionalFields[${index}].path`),
    type: field.type,
    required: boolean(field.required, `additionalFields[${index}].required`),
    allowedValues,
    minimum,
    maximum,
    maximumLength,
    pattern: safePattern(field.pattern, `additionalFields[${index}].pattern`),
  };
}

function validateEntry(value: unknown): SignalContractDefinition['entry'] {
  const entry = record(value, 'entry');
  exactKeys(entry, 'entry', ['mode', 'typePath', 'marketValues', 'rangeValues', 'minimumPath', 'maximumPath']);
  if (!ENTRY_MODES.has(entry.mode)) throw new Error('entry.mode is invalid.');
  const typePath = optionalPath(entry.typePath, 'entry.typePath');
  const marketValues = strings(entry.marketValues ?? [], 'entry.marketValues');
  const rangeValues = strings(entry.rangeValues ?? [], 'entry.rangeValues');
  if (entry.mode === 'typed' && (!typePath || marketValues.length === 0 || rangeValues.length === 0)) {
    throw new Error('Typed entries require a type path plus market and range values.');
  }
  if (entry.mode !== 'typed' && (typePath || marketValues.length > 0 || rangeValues.length > 0)) {
    throw new Error('Only typed entries may define entry type values.');
  }
  return {
    mode: entry.mode,
    typePath,
    marketValues,
    rangeValues,
    minimumPath: pathValue(entry.minimumPath, 'entry.minimumPath'),
    maximumPath: pathValue(entry.maximumPath, 'entry.maximumPath'),
  };
}

function validateTargets(value: unknown): SignalContractDefinition['targets'] {
  const targets = record(value, 'targets');
  exactKeys(targets, 'targets', [
    'containerPath', 'itemTag', 'shape', 'minimumPath', 'maximumPath',
    'minimumItems', 'maximumItems', 'sequentialIds',
  ]);
  if (!TARGET_SHAPES.has(targets.shape)) throw new Error('targets.shape is invalid.');
  const minimumItems = integer(targets.minimumItems, 'targets.minimumItems', 1, 20);
  const maximumItems = integer(targets.maximumItems, 'targets.maximumItems', minimumItems, 20);
  return {
    containerPath: pathValue(targets.containerPath, 'targets.containerPath'),
    itemTag: pathValue(targets.itemTag, 'targets.itemTag'),
    shape: targets.shape,
    minimumPath: pathValue(targets.minimumPath, 'targets.minimumPath'),
    maximumPath: pathValue(targets.maximumPath, 'targets.maximumPath'),
    minimumItems,
    maximumItems,
    sequentialIds: boolean(targets.sequentialIds, 'targets.sequentialIds'),
  };
}

function booleanRecord<T extends Record<string, boolean>>(
  value: unknown,
  label: string,
  keys: Array<keyof T & string>,
): T {
  const input = record(value, label);
  exactKeys(input, label, keys);
  return Object.fromEntries(keys.map(key => [key, boolean(input[key], `${label}.${key}`)])) as T;
}

function uniqueContractPaths(definition: SignalContractDefinition): void {
  const paths = [
    definition.actionPath,
    definition.pairPath,
    definition.entry.typePath,
    definition.entry.minimumPath,
    definition.entry.maximumPath,
    definition.stopLossPath,
    definition.leveragePath,
    definition.riskPercentPath,
    definition.averagingPricePath,
    ...definition.additionalFields.map(field => field.path),
  ].filter((value): value is string => Boolean(value));
  if (new Set(paths).size !== paths.length) throw new Error('Contract field paths must be unique.');
}

export function validateSignalContractDefinition(input: unknown): SignalContractDefinition {
  const value = record(input, 'Signal contract definition');
  exactKeys(value, 'Signal contract definition', [
    'schemaVersion', 'rootTag', 'actionPath', 'pairPath', 'entry', 'targets',
    'stopLossPath', 'leveragePath', 'riskPercentPath', 'averagingPricePath',
    'additionalFields', 'geometry', 'grounding',
  ]);
  if (value.schemaVersion !== 1) throw new Error('Unsupported signal contract schema version.');
  if (value.rootTag !== 'signal') throw new Error("Signal contract rootTag must be 'signal'.");
  if (!Array.isArray(value.additionalFields) || value.additionalFields.length > 30) {
    throw new Error('Signal contract may contain at most 30 additional fields.');
  }
  const definition: SignalContractDefinition = {
    schemaVersion: 1,
    rootTag: 'signal',
    actionPath: pathValue(value.actionPath, 'actionPath'),
    pairPath: pathValue(value.pairPath, 'pairPath'),
    entry: validateEntry(value.entry),
    targets: validateTargets(value.targets),
    stopLossPath: pathValue(value.stopLossPath, 'stopLossPath'),
    leveragePath: optionalPath(value.leveragePath, 'leveragePath'),
    riskPercentPath: optionalPath(value.riskPercentPath, 'riskPercentPath'),
    averagingPricePath: optionalPath(value.averagingPricePath, 'averagingPricePath'),
    additionalFields: value.additionalFields.map((field, index) => additionalField(field, index)),
    geometry: booleanRecord(value.geometry, 'geometry', [
      'stopOnLossSide', 'targetsOnProfitSide', 'orderedTargets', 'orderedRanges',
    ]),
    grounding: booleanRecord(value.grounding, 'grounding', [
      'action', 'pair', 'entry', 'targets', 'stopLoss', 'leverage', 'riskPercent', 'averagingPrice',
    ]),
  };
  uniqueContractPaths(definition);
  return definition;
}

export function signalContractDefinitionSha256(definition: SignalContractDefinition): string {
  return createHash('sha256').update(JSON.stringify(validateSignalContractDefinition(definition))).digest('hex');
}

const GEOMETRY = {
  stopOnLossSide: true,
  targetsOnProfitSide: true,
  orderedTargets: true,
  orderedRanges: true,
} as const;

const GROUNDING = {
  action: true,
  pair: true,
  entry: true,
  targets: true,
  stopLoss: true,
  leverage: true,
  riskPercent: true,
  averagingPrice: true,
} as const;

export const BUILTIN_SIGNAL_CONTRACTS: ReadonlyArray<{
  id: 'standard' | 'cryptodanielvip' | 'loma';
  name: string;
  description: string;
  definition: SignalContractDefinition;
}> = [
  {
    id: 'standard',
    name: 'Standard',
    description: 'Standard XML trading signal contract.',
    definition: {
      schemaVersion: 1,
      rootTag: 'signal',
      actionPath: 'action',
      pairPath: 'pair',
      entry: {
        mode: 'optional_range',
        marketValues: [],
        rangeValues: [],
        minimumPath: 'entry_range.min',
        maximumPath: 'entry_range.max',
      },
      targets: {
        containerPath: 'targets',
        itemTag: 'target',
        shape: 'scalar',
        minimumPath: 'min',
        maximumPath: 'max',
        minimumItems: 1,
        maximumItems: 20,
        sequentialIds: true,
      },
      stopLossPath: 'stoploss',
      leveragePath: 'leverage',
      additionalFields: [],
      geometry: { ...GEOMETRY },
      grounding: { ...GROUNDING },
    },
  },
  {
    id: 'cryptodanielvip',
    name: 'CryptoDaniel VIP',
    description: 'CryptoDaniel VIP executable XML contract.',
    definition: {
      schemaVersion: 1,
      rootTag: 'signal',
      actionPath: 'action',
      pairPath: 'pair',
      entry: {
        mode: 'typed',
        typePath: 'entry_type',
        marketValues: ['MARKET'],
        rangeValues: ['LIMIT'],
        minimumPath: 'entry_range.min',
        maximumPath: 'entry_range.max',
      },
      targets: {
        containerPath: 'targets',
        itemTag: 'target',
        shape: 'scalar',
        minimumPath: 'min',
        maximumPath: 'max',
        minimumItems: 1,
        maximumItems: 20,
        sequentialIds: true,
      },
      stopLossPath: 'stoploss',
      riskPercentPath: 'risk_percent',
      averagingPricePath: 'averaging',
      additionalFields: [],
      geometry: { ...GEOMETRY },
      grounding: { ...GROUNDING },
    },
  },
  {
    id: 'loma',
    name: 'Loma',
    description: 'Loma executable XML contract.',
    definition: {
      schemaVersion: 1,
      rootTag: 'signal',
      actionPath: 'action',
      pairPath: 'pair',
      entry: {
        mode: 'required_range',
        marketValues: [],
        rangeValues: [],
        minimumPath: 'entry_range.min',
        maximumPath: 'entry_range.max',
      },
      targets: {
        containerPath: 'targets',
        itemTag: 'target',
        shape: 'range',
        minimumPath: 'min',
        maximumPath: 'max',
        minimumItems: 1,
        maximumItems: 20,
        sequentialIds: true,
      },
      stopLossPath: 'stoploss',
      additionalFields: [{
        path: 'timeframe',
        type: 'text',
        required: true,
        allowedValues: [],
        pattern: String.raw`^[MHDW]\d{1,3}(?:/[MHDW]\d{1,3})*$`,
      }],
      geometry: { ...GEOMETRY },
      grounding: { ...GROUNDING },
    },
  },
];
