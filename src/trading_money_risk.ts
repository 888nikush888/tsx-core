import { decimal } from './trading_decimal.js';
import {
  addMoneyValues, moneyValueFromDecimal, negateMoneyValue, validateMoneyValue, type MoneyValue,
} from './trading_money_value.js';
import { compareRational, rationalFromDecimal, type ExactRational } from './trading_rational.js';

export type MoneyComparison = -1 | 0 | 1 | 'uncertain';
export interface MonetaryDailyRiskInput {
  budget: string;
  ledgerPnl: MoneyValue;
  unrealizedPnl: string;
  existingCommitment: MoneyValue;
  candidateCommitment: MoneyValue;
}
export interface MonetaryDailyRisk {
  budget: string;
  dayPnl: MoneyValue;
  consumedLoss: MoneyValue;
  existingCommitment: MoneyValue;
  candidateCommitment: MoneyValue;
  totalCommitment: MoneyValue;
  /** Every possible total is <= budget; equality preserves the existing admission policy. */
  allowed: boolean;
  /** Every possible total is strictly > budget; never infer this from !allowed. */
  breached: boolean;
  /** Consumed loss alone is certainly >= budget, independent of reserved commitments. */
  lossLimitReached: boolean;
  /** Lost exactness, not a claim that a particular comparison or account evidence is unresolved. */
  precisionUncertain: boolean;
}

function compareBound(value: MoneyValue, threshold: ExactRational, bound: 'lower' | 'upper'): -1 | 0 | 1 {
  const comparison = compareRational(value.exact ?? rationalFromDecimal(value[bound]), threshold);
  if (comparison < 0) return -1;
  return comparison > 0 ? 1 : 0;
}

/** Touching an interval endpoint cannot distinguish strict ordering from equality. */
export function compareMoneyValue(value: MoneyValue, thresholdDecimal: string): MoneyComparison {
  const source = validateMoneyValue(value), threshold = rationalFromDecimal(thresholdDecimal);
  const lower = compareBound(source, threshold, 'lower');
  if (source.exact) return lower;
  if (compareBound(source, threshold, 'upper') < 0) return -1;
  return lower > 0 ? 1 : 'uncertain';
}

function nonnegativeCommitment(value: MoneyValue): MoneyValue {
  const source = validateMoneyValue(value);
  if (compareBound(source, rationalFromDecimal('0'), 'lower') < 0) {
    throw new Error('Monetary commitment must be proven nonnegative.');
  }
  return source;
}

function zeroWithTerms(terms: number): MoneyValue {
  return { ...moneyValueFromDecimal('0'), terms };
}

function consumedLossFor(dayPnl: MoneyValue): MoneyValue {
  const loss = negateMoneyValue(dayPnl);
  if (loss.exact) {
    return compareBound(loss, rationalFromDecimal('0'), 'lower') > 0 ? loss : zeroWithTerms(loss.terms);
  }
  const lower = loss.lower.startsWith('-') ? '0' : loss.lower;
  const upper = loss.upper.startsWith('-') ? '0' : loss.upper;
  if (upper === '0') return zeroWithTerms(loss.terms);
  return validateMoneyValue({ ...loss, lower, upper });
}

function normalizedBudget(value: string): string {
  if (typeof value !== 'string' || /\s/.test(value)) throw new Error('Invalid monetary risk budget.');
  return decimal(value);
}

/** Pure arithmetic only: an ambiguous interval denies admission but never proves a breach. */
export function calculateMonetaryDailyRisk(input: MonetaryDailyRiskInput): MonetaryDailyRisk {
  const budget = normalizedBudget(input.budget), threshold = rationalFromDecimal(budget);
  const ledgerPnl = validateMoneyValue(input.ledgerPnl);
  const existingCommitment = nonnegativeCommitment(input.existingCommitment);
  const candidateCommitment = nonnegativeCommitment(input.candidateCommitment);
  const dayPnl = addMoneyValues(ledgerPnl, moneyValueFromDecimal(input.unrealizedPnl));
  const consumedLoss = consumedLossFor(dayPnl);
  const totalCommitment = addMoneyValues(addMoneyValues(consumedLoss, existingCommitment), candidateCommitment);
  return {
    budget, dayPnl, consumedLoss, existingCommitment, candidateCommitment, totalCommitment,
    allowed: compareBound(totalCommitment, threshold, 'upper') <= 0,
    breached: compareBound(totalCommitment, threshold, 'lower') > 0,
    lossLimitReached: compareBound(consumedLoss, threshold, 'lower') >= 0,
    precisionUncertain: [ledgerPnl, existingCommitment, candidateCommitment, dayPnl, consumedLoss, totalCommitment]
      .some(value => value.precision === 'bounded'),
  };
}
