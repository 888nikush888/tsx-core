import type { TradingCredentialStore } from './trading_credentials.js';
import { internalExecutorOrigin } from './executor_origin.js';
import { tradingExchangeId } from './trading_types.js';

export type ExchangeCertificationStatus =
  | 'discovered'
  | 'candidate'
  | 'certified'
  | 'quarantined'
  | 'ineligible'
  | 'deprecated';

export interface ExchangeCredentialField {
  id: string;
  label: string;
  required: boolean;
  secret: boolean;
}

export interface ExchangeCatalogEntry {
  id: string;
  name: string;
  status: ExchangeCertificationStatus;
  reason: string | null;
  provider: 'paper' | 'ccxt';
  ccxt: { rest: boolean; pro: boolean } | null;
  markets: { linearSwap: boolean | null };
  credentialFields: ExchangeCredentialField[];
  modes: Array<'paper' | 'testnet' | 'live'>;
  capabilities: Record<string, unknown>;
}

export interface ExchangeCatalog {
  implementation: {
    library: 'ccxt';
    version: string;
    streaming: 'ccxt-pro';
    orderAuthority: 'rest';
  };
  exchanges: ExchangeCatalogEntry[];
}

type FetchLike = (url: string, init: RequestInit) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

interface ExchangeCatalogClientOptions {
  baseUrl?: string;
  cacheTtlMs?: number;
  fetchImpl?: FetchLike;
}

const STATUS_VALUES = new Set<ExchangeCertificationStatus>([
  'discovered', 'candidate', 'certified', 'quarantined', 'ineligible', 'deprecated',
]);
const MODE_VALUES = new Set(['paper', 'testnet', 'live']);
const CREDENTIAL_IDS = new Set([
  'apiKey', 'secret', 'uid', 'accountId', 'login', 'password', 'twofa',
  'privateKey', 'walletAddress', 'token',
]);

function object(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} returned an invalid contract.`);
  }
  return value as Record<string, any>;
}

function safeReason(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 500 || /[\r\n\0]/.test(value)) {
    throw new Error('Exchange catalog returned an invalid reason.');
  }
  return value;
}

function safeCapabilities(value: unknown): Record<string, unknown> {
  const source = object(value, 'Exchange catalog capabilities');
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(key)
      || !['boolean', 'number', 'string'].includes(typeof item) && item !== null) {
      throw new Error('Exchange catalog returned invalid capabilities.');
    }
    result[key] = item;
  }
  return result;
}

function catalogEntry(value: unknown): ExchangeCatalogEntry {
  const input = object(value, 'Exchange catalog');
  const id = tradingExchangeId(input.id);
  if (typeof input.name !== 'string' || input.name.trim().length < 1 || input.name.length > 100) {
    throw new Error('Exchange catalog returned an invalid exchange name.');
  }
  if (!STATUS_VALUES.has(input.status)) throw new Error('Exchange catalog returned an invalid status.');
  if (input.provider !== 'ccxt') throw new Error('Executor catalog may only contain CCXT exchanges.');
  const ccxt = object(input.ccxt, 'Exchange catalog CCXT metadata');
  if (typeof ccxt.rest !== 'boolean' || typeof ccxt.pro !== 'boolean') {
    throw new TypeError('Exchange catalog returned invalid CCXT metadata.');
  }
  const markets = object(input.markets, 'Exchange catalog market metadata');
  if (markets.linearSwap !== null && typeof markets.linearSwap !== 'boolean') {
    throw new Error('Exchange catalog returned invalid market metadata.');
  }
  if (!Array.isArray(input.credentialFields) || !Array.isArray(input.modes)) {
    throw new TypeError('Exchange catalog returned invalid fields or modes.');
  }
  const credentialFields = input.credentialFields.map((value: unknown) => {
    const field = object(value, 'Exchange credential field');
    if (!CREDENTIAL_IDS.has(field.id) || typeof field.label !== 'string'
      || field.label.length < 1 || field.label.length > 80
      || typeof field.required !== 'boolean' || typeof field.secret !== 'boolean') {
      throw new Error('Exchange catalog returned an invalid credential field.');
    }
    return { id: field.id, label: field.label, required: field.required, secret: field.secret };
  });
  if (new Set(credentialFields.map(field => field.id)).size !== credentialFields.length) {
    throw new Error('Exchange catalog returned duplicate credential fields.');
  }
  const modes = input.modes.map((mode: unknown) => {
    if (typeof mode !== 'string' || !MODE_VALUES.has(mode) || mode === 'paper') {
      throw new Error('CCXT exchange catalog returned an invalid mode.');
    }
    return mode as 'testnet' | 'live';
  });
  if (input.status !== 'certified' && modes.length > 0) {
    throw new Error('Non-certified exchange catalog entries cannot expose account modes.');
  }
  return {
    id,
    name: input.name.trim(),
    status: input.status,
    reason: safeReason(input.reason),
    provider: 'ccxt',
    ccxt: { rest: ccxt.rest, pro: ccxt.pro },
    markets: { linearSwap: markets.linearSwap },
    credentialFields,
    modes,
    capabilities: safeCapabilities(input.capabilities),
  };
}

function executorCatalog(value: unknown): ExchangeCatalog {
  const input = object(value, 'Exchange executor catalog');
  const implementation = object(input.implementation, 'Exchange executor implementation');
  if (implementation.library !== 'ccxt' || implementation.streaming !== 'ccxt-pro'
    || implementation.orderAuthority !== 'rest'
    || typeof implementation.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(implementation.version)) {
    throw new Error('Exchange executor returned invalid implementation metadata.');
  }
  if (!Array.isArray(input.exchanges)) throw new Error('Exchange executor returned an invalid exchange list.');
  const exchanges = input.exchanges.map(catalogEntry);
  if (new Set(exchanges.map(exchange => exchange.id)).size !== exchanges.length) {
    throw new Error('Exchange executor catalog contains duplicate exchange identifiers.');
  }
  return {
    implementation: {
      library: 'ccxt',
      version: implementation.version,
      streaming: 'ccxt-pro',
      orderAuthority: 'rest',
    },
    exchanges,
  };
}

const PAPER_ENTRY: ExchangeCatalogEntry = {
  id: 'paper',
  name: 'Paper Trading',
  status: 'certified',
  reason: null,
  provider: 'paper',
  ccxt: null,
  markets: { linearSwap: true },
  credentialFields: [],
  modes: ['paper'],
  capabilities: {},
};

export class ExchangeCatalogClient {
  private readonly baseUrl: string;
  private readonly cacheTtlMs: number;
  private readonly fetchImpl: FetchLike;
  private cached: { expiresAt: number; catalog: ExchangeCatalog } | null = null;
  private inFlight: Promise<ExchangeCatalog> | null = null;

  constructor(
    private readonly credentials: Pick<TradingCredentialStore, 'getOrCreateExecutorToken'>,
    options: ExchangeCatalogClientOptions = {},
  ) {
    this.baseUrl = internalExecutorOrigin(options.baseUrl ?? process.env.EXCHANGE_EXECUTOR_URL);
    this.cacheTtlMs = Math.max(1_000, Math.min(options.cacheTtlMs ?? 15_000, 60_000));
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike);
  }

  async executorCatalog(force = false): Promise<ExchangeCatalog> {
    if (!force && this.cached && this.cached.expiresAt > Date.now()) return this.cached.catalog;
    if (!force && this.inFlight !== null) return this.inFlight;
    const request = this.postCatalog('/v1/exchange-catalog', {});
    this.inFlight = request;
    try {
      const catalog = await request;
      this.cached = { expiresAt: Date.now() + this.cacheTtlMs, catalog };
      return catalog;
    } finally {
      if (this.inFlight === request) this.inFlight = null;
    }
  }

  async browserCatalog(force = false): Promise<ExchangeCatalog> {
    const catalog = await this.executorCatalog(force);
    return { ...catalog, exchanges: [PAPER_ENTRY, ...catalog.exchanges] };
  }

  async probe(exchange: unknown): Promise<ExchangeCatalogEntry> {
    const id = tradingExchangeId(exchange);
    if (id === 'paper') throw new Error('Paper trading does not require a CCXT compatibility probe.');
    const token = await this.credentials.getOrCreateExecutorToken();
    const response = await this.fetchImpl(`${this.baseUrl}/v1/exchange-probe`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ exchange: id }),
      signal: AbortSignal.timeout(35_000),
    });
    if (!response.ok) throw new Error(`Exchange compatibility probe failed with status ${response.status}.`);
    const entry = catalogEntry(await response.json());
    if (entry.id !== id) throw new Error('Exchange compatibility probe returned a different exchange.');
    this.cached = null;
    return entry;
  }

  private async postCatalog(endpoint: string, payload: Record<string, unknown>): Promise<ExchangeCatalog> {
    const token = await this.credentials.getOrCreateExecutorToken();
    const response = await this.fetchImpl(`${this.baseUrl}${endpoint}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Exchange catalog request failed with status ${response.status}.`);
    return executorCatalog(await response.json());
  }
}
