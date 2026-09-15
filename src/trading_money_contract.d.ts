import type { MoneyValue } from './trading_money_value.js';

export interface ReportingCurrencyBinding {
  accountId: string;
  accountFingerprint: string;
  profile: string;
  reportingCurrency: string;
  settlementAssets: string[];
  source: string;
  verifiedAt: number;
}

export interface MoneyEventInput {
  accountId: string;
  accountFingerprint: string;
  providerEventId: string;
  kind: 'fee' | 'funding' | 'realized_price_pnl';
  source: string;
  basis: 'fill' | 'provider';
  occurredAt: number;
  amount: string;
  asset: string | null;
  intentId?: string | null;
  fillId?: string | null;
  derivation?: string;
}

export interface MoneyEvent extends MoneyEventInput {
  id: string;
  valuationStatus: 'valued' | 'unresolved';
  reportingAmount: string | null;
  reportingCurrency: string | null;
  reportingValue?: MoneyValue | null;
  valuationEvidenceId?: string | null;
}
