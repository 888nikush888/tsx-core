import { addSignedDecimal, signedDecimal } from './trading_decimal.js';
import { isDeepStrictEqual } from 'node:util';
import { moneyValueFromDecimal, validateMoneyValue, type MoneyValue } from './trading_money_value.js';
import type { ExchangeFillAccounting, TradingAccountingEvidence, TradingFundingEvidence } from './trading_types.js';
import type { FundingObservationProof } from './trading_account_log_contract.js';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid accounting evidence object.');
  return value as Record<string, unknown>;
}

function token(value: unknown, maximum = 256): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > maximum || value.trim() !== value || /[\x00-\x1f]/.test(value)) throw new Error('Invalid accounting evidence identity.');
}

function asset(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(value)) throw new Error('Invalid accounting asset.');
}

function timestamp(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid accounting timestamp.');
}

export function validateFillAccounting(value: unknown, providerSymbol?: string): ExchangeFillAccounting {
  const row = object(value);
  if (row.version !== 1 || row.linear !== true || row.quantityUnit !== 'base'
    || !['ccxt-market-v1', 'paper-contract-v1'].includes(String(row.source))) throw new Error('Unsupported fill accounting contract.');
  token(row.providerSymbol); asset(row.settlementAsset);
  if (providerSymbol !== undefined && row.providerSymbol !== providerSymbol) throw new Error('Fill accounting market differs from the provider market.');
  return { version: 1, source: row.source as ExchangeFillAccounting['source'], providerSymbol: row.providerSymbol,
    settlementAsset: row.settlementAsset, linear: true, quantityUnit: 'base' };
}

function fundingEvent(value: unknown, since: number, until: number): TradingFundingEvidence['events'][number] {
  const row = object(value);
  token(row.id); timestamp(row.timestamp);
  if (row.timestamp < since || row.timestamp > until) throw new Error('Funding event is outside its evidence window.');
  if (typeof row.amount !== 'string' || row.amount.trim() !== row.amount) throw new Error('Invalid funding amount.');
  if (row.asset !== null) asset(row.asset);
  return { id: row.id, timestamp: row.timestamp, amount: signedDecimal(row.amount), asset: row.asset as string | null };
}

export function validateFundingEvidence(value: unknown): TradingFundingEvidence {
  const row = object(value);
  if (!['complete', 'incomplete', 'unsupported'].includes(String(row.status))) throw new Error('Invalid funding completeness.');
  timestamp(row.since); timestamp(row.until); timestamp(row.nextReadAt);
  if (row.until < row.since || row.until - row.since > 86_400_000) throw new Error('Invalid bounded funding window.');
  token(row.source);
  if (row.cursor !== null) token(row.cursor, 4096);
  if (row.reason !== null) token(row.reason);
  if (row.status === 'complete' && (row.cursor !== null || row.reason !== null)) throw new Error('Complete funding evidence retains unresolved continuation.');
  if (!Array.isArray(row.events) || row.events.length > 25_000) throw new Error('Invalid bounded funding event collection.');
  const events = row.events.map(event => fundingEvent(event, row.since as number, row.until as number));
  if (new Set(events.map(event => event.id)).size !== events.length) throw new Error('Duplicate funding event identity.');
  const observation = observationEnvelope(row, events.length);
  return { status: row.status as TradingFundingEvidence['status'], since: row.since, until: row.until,
    ...(observation ? { observation } : {}),
    cursor: row.cursor as string | null, source: row.source, reason: row.reason as string | null, nextReadAt: row.nextReadAt, events };
}
function observationEnvelope(row: Record<string, unknown>, eventCount: number): FundingObservationProof | undefined {
  if (row.observation === undefined) return undefined;
  const proof = fundingObservation(row.observation);
  if (proof.since !== row.since || Math.max(proof.since, proof.through) !== row.until
    || proof.namespace !== row.source || (proof.status === 'observed') !== (row.status === 'complete')
    || eventCount !== 0) throw new Error('Funding observation contradicts its envelope.');
  return proof;
}

export function fundingTotal(evidence: TradingFundingEvidence, reportingCurrency: string): string | null {
  return fundingTotalValue(evidence, reportingCurrency)?.decimal ?? null;
}

/** Authority still comes from the funding envelope and, for observations, its durable source recheck. */
export function fundingTotalValue(evidence: TradingFundingEvidence, reportingCurrency: string): MoneyValue | null {
  if (evidence.status !== 'complete') return null;
  if (evidence.observation) {
    const proof = evidence.observation;
    if (proof.status !== 'observed' || proof.reportingCurrency !== reportingCurrency) return null;
    return proof.value === undefined ? decimalFundingValue(proof.amount) : proof.value;
  }
  let total = '0';
  for (const event of evidence.events) {
    if (event.amount !== '0' && event.asset !== reportingCurrency) return null;
    total = addSignedDecimal(total, event.amount);
  }
  return moneyValueFromDecimal(total);
}

function decimalFundingValue(value: string | null): MoneyValue | null {
  return value === null ? null : moneyValueFromDecimal(value);
}

/** Structural validation only. A self-supplied value does not authorize funding or entry. */
export function validateFundingValue(amount: string | null, value: unknown): MoneyValue | null | undefined {
  if (value === undefined) return undefined;
  const result = value === null ? null : validateMoneyValue(value);
  if (amount !== (result?.decimal ?? null)) throw new Error('Funding decimal alias contradicts its money value.');
  return result;
}

function fundingObservation(value: unknown): FundingObservationProof {
  const row = object(value);
  observationIdentity(row);
  timestamp(row.since); timestamp(row.through);
  if (row.reportingCurrency !== null) asset(row.reportingCurrency);
  if (row.reason !== null) token(row.reason);
  const amount = row.amount === null ? null : signedDecimal(row.amount as string);
  const monetary = validateFundingValue(row.amount as string | null, row.value);
  const known = monetary === undefined ? amount !== null : monetary !== null;
  if (row.status === 'observed' && (!known || row.reportingCurrency === null || row.reason !== null)) throw new Error('Observed funding has unresolved valuation.');
  return { version: 1, status: row.status as FundingObservationProof['status'], namespace: row.namespace as string,
    accountFingerprint: row.accountFingerprint as string, credentialGeneration: row.credentialGeneration as string,
    revisionHash: row.revisionHash as string, since: row.since as number, through: row.through as number,
    reportingCurrency: row.reportingCurrency as string | null, amount, reason: row.reason as string | null,
    ...(monetary === undefined ? {} : { value: monetary }),
    sourceScope: 'source_account', finality: 'provider_as_observed', delivery: 'may_be_delayed' };
}
function observationIdentity(row: Record<string, unknown>): void {
  if (row.version !== 1 || !['observed', 'incomplete'].includes(String(row.status)) || row.sourceScope !== 'source_account'
    || row.finality !== 'provider_as_observed' || row.delivery !== 'may_be_delayed') throw new Error('Invalid observed funding proof.');
  token(row.namespace);
  for (const field of ['accountFingerprint', 'credentialGeneration', 'revisionHash']) {
    if (typeof row[field] !== 'string' || !/^[a-f0-9]{64}$/.test(row[field])) throw new Error('Invalid funding observation binding.');
  }
}

export function validateAccountingEvidence(value: unknown, fundingPnlToday: string | null, fundingPnlTodayValue?: unknown): TradingAccountingEvidence {
  const row = object(value);
  token(row.accountFingerprint); token(row.source); asset(row.reportingCurrency); timestamp(row.observedAt);
  if (!Array.isArray(row.settlementAssets) || row.settlementAssets.length > 1000) throw new Error('Invalid accounting settlement metadata.');
  row.settlementAssets.forEach(asset);
  if (new Set(row.settlementAssets).size !== row.settlementAssets.length) throw new Error('Duplicate accounting settlement asset.');
  if (!['price_only', 'unverified'].includes(String(row.unrealizedPnlSemantics))) throw new Error('Missing unrealized PnL semantics.');
  const funding = validateFundingEvidence(row.funding);
  if (funding.observation && (funding.observation.accountFingerprint !== row.accountFingerprint
    || funding.observation.reportingCurrency !== row.reportingCurrency)) throw new Error('Funding observation accounting binding differs.');
  const reported = fundingPnlToday === null ? null : signedDecimal(fundingPnlToday);
  if (fundingTotal(funding, row.reportingCurrency) !== reported) throw new Error('Funding total contradicts its currency/completeness evidence.');
  const monetary = validateFundingValue(fundingPnlToday, fundingPnlTodayValue);
  if (monetary !== undefined && !isDeepStrictEqual(monetary, fundingTotalValue(funding, row.reportingCurrency))) {
    throw new Error('Funding money value contradicts its accounting evidence.');
  }
  return { accountFingerprint: row.accountFingerprint, reportingCurrency: row.reportingCurrency,
    settlementAssets: row.settlementAssets as string[], source: row.source, observedAt: row.observedAt,
    unrealizedPnlSemantics: row.unrealizedPnlSemantics as TradingAccountingEvidence['unrealizedPnlSemantics'], funding };
}
