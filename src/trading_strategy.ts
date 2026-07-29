import { createHash, randomUUID } from 'node:crypto';
import { compareDecimal, decimal, sumDecimals } from './trading_decimal.js';
import type { StrategyConfiguration, TradingStrategyVersion } from './trading_types.js';

const SYMBOL_PATTERN = /^[A-Z0-9]{2,20}$/;
export const SIGNAL_SCHEMA_ID_PATTERN = /^[a-z][a-z0-9_-]{0,39}$/;

export function signalSchemaIdentifier(value: unknown, label = 'Signal schema identifier'): string {
  if (typeof value !== 'string') throw new Error(`${label} is invalid.`);
  const normalized = value.trim().toLowerCase();
  if (!SIGNAL_SCHEMA_ID_PATTERN.test(normalized)) {
    throw new Error(`${label} must start with a lowercase letter and contain only lowercase letters, numbers, '_' or '-'.`);
  }
  return normalized;
}

export const DEFAULT_STRATEGY_CONFIGURATION: StrategyConfiguration = {
  schemaVersion: 3,
  allowedSignalSchemas: ['standard', 'cryptodanielvip', 'loma'],
  symbolPolicy: 'all',
  allowedSymbols: [],
  allowedSides: ['LONG', 'SHORT'],
  entry: {
    orderType: 'limit',
    rangePrice: 'midpoint',
    postOnly: false,
    timeoutSeconds: 10,
  },
  sizing: {
    riskPerTradePercent: '1',
    maxAdaptiveRiskPercent: '1',
    maxPositionNotional: '1000',
    maxLeverage: 3,
  },
  exits: {
    targetAllocationMode: 'manual',
    targetAllocationsPercent: ['50', '50'],
    stopLossMode: 'configured',
    moveStopToBreakEvenAfterTarget: 1,
    trailingStopPercent: null,
    closeRemainderAtLastTarget: true,
  },
  safety: {
    maxConcurrentPositions: 1,
    maxDailyLoss: '100',
    maxSlippagePercent: '0.5',
    entryOrderTtlSeconds: 900,
    requireProtectiveStop: true,
  },
};

function integer(value: unknown, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return Number(value);
}

function uniqueStrings(values: unknown, name: string): string[] {
  if (!Array.isArray(values) || values.some(value => typeof value !== 'string')) {
    throw new Error(`${name} must be an array of strings.`);
  }
  const normalized = values.map(value => value.trim().toUpperCase());
  if (new Set(normalized).size !== normalized.length) throw new Error(`${name} must not contain duplicates.`);
  return normalized;
}

function object(value: unknown, name: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object.`);
  return value as Record<string, any>;
}

function exactKeys(value: Record<string, any>, name: string, keys: string[]): void {
  const extras = Object.keys(value).filter(key => !keys.includes(key));
  if (extras.length > 0) throw new Error(`${name} contains unsupported fields: ${extras.join(', ')}.`);
}

function validateAccess(value: Record<string, any>): Pick<StrategyConfiguration,
  'schemaVersion' | 'allowedSignalSchemas' | 'symbolPolicy' | 'allowedSymbols' | 'allowedSides'
> {
  if (value.schemaVersion !== 1 && value.schemaVersion !== 2 && value.schemaVersion !== 3) {
    throw new Error('Unsupported strategy schema version.');
  }
  if (!Array.isArray(value.allowedSignalSchemas) || value.allowedSignalSchemas.some(schema => typeof schema !== 'string')) {
    throw new Error('allowedSignalSchemas must be an array of strings.');
  }
  const schemas = value.allowedSignalSchemas.map(schema => signalSchemaIdentifier(schema));
  if (schemas.length < 1) throw new Error('At least one executable signal schema is required.');
  if (new Set(schemas).size !== schemas.length) throw new Error('allowedSignalSchemas must not contain duplicates.');
  const symbols = uniqueStrings(value.allowedSymbols, 'allowedSymbols');
  if (symbols.some(symbol => !SYMBOL_PATTERN.test(symbol))) throw new Error('allowedSymbols contains an invalid normalized symbol.');
  const legacySymbolPolicy = symbols.length > 0 ? 'allowlist' : 'all';
  const symbolPolicy = value.schemaVersion === 3 ? value.symbolPolicy : value.symbolPolicy ?? legacySymbolPolicy;
  if (!['all', 'none', 'allowlist'].includes(symbolPolicy)) {
    throw new Error('symbolPolicy must be all, none, or allowlist.');
  }
  if (value.schemaVersion !== 3 && symbolPolicy !== legacySymbolPolicy) {
    throw new Error('Legacy strategy schemas may only use their derived symbolPolicy.');
  }
  if (symbolPolicy === 'allowlist' && symbols.length === 0) {
    throw new Error('symbolPolicy allowlist requires at least one allowed symbol.');
  }
  if (symbolPolicy !== 'allowlist' && symbols.length > 0) {
    throw new Error('allowedSymbols must be empty unless symbolPolicy is allowlist.');
  }
  const sides = uniqueStrings(value.allowedSides, 'allowedSides');
  if (sides.length < 1 || sides.some(side => side !== 'LONG' && side !== 'SHORT')) throw new Error('allowedSides must contain LONG and/or SHORT.');
  return {
    schemaVersion: value.schemaVersion,
    allowedSignalSchemas: schemas,
    symbolPolicy: symbolPolicy as StrategyConfiguration['symbolPolicy'],
    allowedSymbols: symbols,
    allowedSides: sides as StrategyConfiguration['allowedSides'],
  };
}

function validateEntry(input: unknown): StrategyConfiguration['entry'] {
  const value = object(input, 'entry');
  exactKeys(value, 'entry', ['orderType', 'rangePrice', 'postOnly', 'timeoutSeconds']);
  if (!['market', 'limit'].includes(value.orderType)) throw new Error('entry.orderType must be market or limit.');
  if (!['near', 'midpoint', 'far'].includes(value.rangePrice)) throw new Error('entry.rangePrice is invalid.');
  if (typeof value.postOnly !== 'boolean') throw new Error('entry.postOnly must be boolean.');
  if (value.orderType === 'market' && value.postOnly) throw new Error('Market entries cannot be post-only.');
  return {
    orderType: value.orderType,
    rangePrice: value.rangePrice,
    postOnly: value.postOnly,
    timeoutSeconds: integer(value.timeoutSeconds, 'entry.timeoutSeconds', 2, 30),
  };
}

function validateSizing(input: unknown, schemaVersion: 1 | 2 | 3): StrategyConfiguration['sizing'] {
  const value = object(input, 'sizing');
  exactKeys(value, 'sizing', [
    'riskPerTradePercent', 'maxAdaptiveRiskPercent', 'maxPositionNotional', 'maxLeverage',
  ]);
  const riskPerTradePercent = decimal(value.riskPerTradePercent, { positive: true, max: '10' });
  const maxAdaptiveRiskPercent = schemaVersion === 1
    ? undefined
    : decimal(value.maxAdaptiveRiskPercent, { positive: true, max: '10' });
  if (maxAdaptiveRiskPercent && compareDecimal(maxAdaptiveRiskPercent, riskPerTradePercent) < 0) {
    throw new Error('sizing.maxAdaptiveRiskPercent must not be below the baseline risk.');
  }
  return {
    riskPerTradePercent,
    ...(maxAdaptiveRiskPercent ? { maxAdaptiveRiskPercent } : {}),
    maxPositionNotional: decimal(value.maxPositionNotional, { positive: true }),
    maxLeverage: integer(value.maxLeverage, 'sizing.maxLeverage', 1, 50),
  };
}

function validateExits(input: unknown): StrategyConfiguration['exits'] {
  const value = object(input, 'exits');
  exactKeys(value, 'exits', [
    'targetAllocationMode', 'targetAllocationsPercent', 'stopLossMode',
    'moveStopToBreakEvenAfterTarget', 'trailingStopPercent', 'closeRemainderAtLastTarget',
  ]);
  const targetAllocationMode = value.targetAllocationMode ?? 'manual';
  if (!['manual', 'adaptive_halving'].includes(targetAllocationMode)) {
    throw new Error('exits.targetAllocationMode must be manual or adaptive_halving.');
  }
  if (!Array.isArray(value.targetAllocationsPercent) || value.targetAllocationsPercent.length < 1) {
    throw new Error('At least one target allocation is required.');
  }
  const allocations = value.targetAllocationsPercent.map(allocation => decimal(allocation, { positive: true, max: '100' }));
  if (compareDecimal(sumDecimals(allocations), '100') !== 0) throw new Error('Target allocations must total exactly 100 percent.');
  const breakEvenTarget = value.moveStopToBreakEvenAfterTarget === null
    ? null
    : integer(
      value.moveStopToBreakEvenAfterTarget,
      'exits.moveStopToBreakEvenAfterTarget',
      1,
      allocations.length,
    );
  const trailingStop = value.trailingStopPercent === null
    ? null
    : decimal(value.trailingStopPercent, { positive: true, max: '20' });
  const stopLossMode = value.stopLossMode ?? 'configured';
  if (!['configured', 'adaptive_targets'].includes(stopLossMode)) {
    throw new Error('exits.stopLossMode must be configured or adaptive_targets.');
  }
  if (value.closeRemainderAtLastTarget !== true) {
    throw new Error('Closing the full remainder at the last target is mandatory.');
  }
  return {
    targetAllocationMode,
    targetAllocationsPercent: allocations,
    stopLossMode,
    moveStopToBreakEvenAfterTarget: breakEvenTarget,
    trailingStopPercent: trailingStop,
    closeRemainderAtLastTarget: true,
  };
}

function validateSafety(input: unknown): StrategyConfiguration['safety'] {
  const value = object(input, 'safety');
  exactKeys(value, 'safety', [
    'maxConcurrentPositions', 'maxDailyLoss', 'maxSlippagePercent',
    'entryOrderTtlSeconds', 'requireProtectiveStop',
  ]);
  if (value.requireProtectiveStop !== true) throw new Error('Protective stops are mandatory.');
  return {
    maxConcurrentPositions: integer(value.maxConcurrentPositions, 'safety.maxConcurrentPositions', 1, 20),
    maxDailyLoss: decimal(value.maxDailyLoss, { positive: true }),
    maxSlippagePercent: decimal(value.maxSlippagePercent, { positive: true, max: '5' }),
    entryOrderTtlSeconds: integer(value.entryOrderTtlSeconds, 'safety.entryOrderTtlSeconds', 10, 86_400),
    requireProtectiveStop: true,
  };
}

export function validateStrategyConfiguration(input: unknown): StrategyConfiguration {
  const value = object(input, 'Strategy configuration');
  if (value.schemaVersion !== 1 && value.schemaVersion !== 2 && value.schemaVersion !== 3) {
    throw new Error('Unsupported strategy schema version.');
  }
  const keys = [
    'schemaVersion', 'allowedSignalSchemas', 'symbolPolicy', 'allowedSymbols', 'allowedSides',
    'entry', 'sizing', 'exits', 'safety',
  ];
  exactKeys(value, 'Strategy configuration', keys);
  const access = validateAccess(value);
  return {
    ...access,
    entry: validateEntry(value.entry),
    sizing: validateSizing(value.sizing, access.schemaVersion),
    exits: validateExits(value.exits),
    safety: validateSafety(value.safety),
  };
}

export function strategyConfigurationSha256(configuration: StrategyConfiguration): string {
  return createHash('sha256').update(JSON.stringify(configuration)).digest('hex');
}

export function createStrategyVersion(input: {
  strategyId?: string;
  version: number;
  name: string;
  description?: string;
  configuration: unknown;
  now?: number;
}): TradingStrategyVersion {
  const name = input.name?.trim();
  if (!name || name.length > 80) throw new Error('Strategy name must contain between 1 and 80 characters.');
  const description = input.description?.trim() || '';
  if (description.length > 500) throw new Error('Strategy description must not exceed 500 characters.');
  const configuration = validateStrategyConfiguration(input.configuration);
  return {
    id: randomUUID(),
    strategyId: input.strategyId || randomUUID(),
    version: integer(input.version, 'version', 1, 1_000_000),
    name,
    description,
    status: 'draft',
    configuration,
    configurationSha256: strategyConfigurationSha256(configuration),
    createdAt: input.now ?? Date.now(),
    publishedAt: null,
  };
}
