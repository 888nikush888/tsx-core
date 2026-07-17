import { createHash, randomUUID } from 'node:crypto';
import { compareDecimal, decimal, sumDecimals } from './trading_decimal.js';
import type { StrategyConfiguration, TradingStrategyVersion } from './trading_types.js';

const SYMBOL_PATTERN = /^[A-Z0-9]{2,20}$/;

export const DEFAULT_STRATEGY_CONFIGURATION: StrategyConfiguration = {
  schemaVersion: 1,
  allowedSignalSchemas: ['standard', 'cryptodanielvip', 'loma'],
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
    maxPositionNotional: '1000',
    maxLeverage: 3,
  },
  exits: {
    targetAllocationsPercent: ['50', '50'],
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
  'schemaVersion' | 'allowedSignalSchemas' | 'allowedSymbols' | 'allowedSides'
> {
  if (value.schemaVersion !== 1) throw new Error('Unsupported strategy schema version.');
  const schemas = uniqueStrings(value.allowedSignalSchemas, 'allowedSignalSchemas').map(item => item.toLowerCase());
  if (schemas.length < 1 || schemas.some(schema => !['standard', 'cryptodanielvip', 'loma'].includes(schema))) {
    throw new Error('At least one supported executable signal schema is required.');
  }
  const symbols = uniqueStrings(value.allowedSymbols, 'allowedSymbols');
  if (symbols.some(symbol => !SYMBOL_PATTERN.test(symbol))) throw new Error('allowedSymbols contains an invalid normalized symbol.');
  const sides = uniqueStrings(value.allowedSides, 'allowedSides');
  if (sides.length < 1 || sides.some(side => side !== 'LONG' && side !== 'SHORT')) throw new Error('allowedSides must contain LONG and/or SHORT.');
  return {
    schemaVersion: 1,
    allowedSignalSchemas: schemas as StrategyConfiguration['allowedSignalSchemas'],
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

function validateSizing(input: unknown): StrategyConfiguration['sizing'] {
  const value = object(input, 'sizing');
  exactKeys(value, 'sizing', ['riskPerTradePercent', 'maxPositionNotional', 'maxLeverage']);
  return {
    riskPerTradePercent: decimal(value.riskPerTradePercent, { positive: true, max: '10' }),
    maxPositionNotional: decimal(value.maxPositionNotional, { positive: true }),
    maxLeverage: integer(value.maxLeverage, 'sizing.maxLeverage', 1, 50),
  };
}

function validateExits(input: unknown): StrategyConfiguration['exits'] {
  const value = object(input, 'exits');
  exactKeys(value, 'exits', [
    'targetAllocationsPercent', 'moveStopToBreakEvenAfterTarget',
    'trailingStopPercent', 'closeRemainderAtLastTarget',
  ]);
  if (!Array.isArray(value.targetAllocationsPercent) || value.targetAllocationsPercent.length < 1 || value.targetAllocationsPercent.length > 20) {
    throw new Error('Between one and twenty target allocations are required.');
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
  if (value.closeRemainderAtLastTarget !== true) {
    throw new Error('Closing the full remainder at the last target is mandatory.');
  }
  return {
    targetAllocationsPercent: allocations,
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
  exactKeys(value, 'Strategy configuration', [
    'schemaVersion', 'allowedSignalSchemas', 'allowedSymbols', 'allowedSides',
    'entry', 'sizing', 'exits', 'safety',
  ]);
  return {
    ...validateAccess(value),
    entry: validateEntry(value.entry),
    sizing: validateSizing(value.sizing),
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
