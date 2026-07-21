import { getDatabase } from './db.js';
import { PaperExchangeAdapter } from './paper_exchange.js';
import type { TradingCredentialStore, TradingCredentials } from './trading_credentials.js';
import { TradingEngine } from './trading_engine.js';
import {
  acknowledgeTradingRiskEvent,
  archiveTradingStrategyVersion,
  createTradingAccount,
  createTradingStrategyDraft,
  deleteTradingAccount,
  deleteTradingRoute,
  deleteTradingStrategyVersion,
  getTradingAccount,
  getTradingAnalytics,
  getTradingOverview,
  listTradingAccounts,
  listTradingActivity,
  listTradingIntents,
  listTradingRoutes,
  listTradingStrategies,
  publishTradingStrategyVersion,
  setTradingRoute,
  updateTradingAccountState,
  updateTradingRuntimeState,
  updateTradingStrategyDraft,
} from './trading_repository.js';
import { decimal, signedDecimal } from './trading_decimal.js';
import type {
  ExchangeOpenState,
  StrategyConfiguration,
  TradingAccount,
  TradingAccountMode,
  TradingExchange,
  TradingExchangeAdapter,
  TradingMarketSnapshot,
} from './trading_types.js';

type VerifiableAdapter = TradingExchangeAdapter & {
  verifyAccount?: (account: TradingAccount) => Promise<{ verified: boolean; equity: string }>;
};

const LIVE_CONFIRMATION = 'ENABLE LIVE TRADING';
const FLATTEN_CONFIRMATION = 'FLATTEN MANAGED POSITIONS';

function identifier(value: unknown, label: string, maximum = 128): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum || /[\r\n\0]/.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value.trim();
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean.`);
  return value;
}

export interface TradingWebSnapshot {
  overview: Awaited<ReturnType<typeof getTradingOverview>>;
  analytics: Awaited<ReturnType<typeof getTradingAnalytics>>;
  strategies: Awaited<ReturnType<typeof listTradingStrategies>>;
  accounts: Array<Omit<TradingAccount, 'credentialRef'> & {
    credentials: Awaited<ReturnType<TradingCredentialStore['status']>>;
  }>;
  routes: Awaited<ReturnType<typeof listTradingRoutes>>;
  intents: Awaited<ReturnType<typeof listTradingIntents>>;
  activity: Awaited<ReturnType<typeof listTradingActivity>>;
  confirmations: { live: string; emergencyFlatten: string };
}

export interface TradingPortfolioAccountSnapshot {
  accountId: string;
  name: string;
  exchange: TradingExchange;
  mode: TradingAccountMode;
  enabled: boolean;
  status: string;
  reportingCurrency: 'QUOTE' | 'USDC' | 'USD';
  equity: string | null;
  availableBalance: string | null;
  unrealizedPnl: string | null;
  marginUsed: string | null;
  observedAt: number | null;
  error: string | null;
}

export interface TradingPortfolioSnapshot {
  accounts: TradingPortfolioAccountSnapshot[];
  observedAt: number;
  cached: boolean;
}

export class TradingWebControl {
  private readonly adapters = new Map<TradingExchange, VerifiableAdapter>();
  private portfolioCache: { value: TradingPortfolioSnapshot; expiresAt: number } | null = null;
  private portfolioRefresh: Promise<TradingPortfolioSnapshot> | null = null;

  constructor(
    private readonly credentials: TradingCredentialStore,
    private readonly paper: PaperExchangeAdapter,
    adapters: VerifiableAdapter[],
    private readonly engine: TradingEngine,
  ) {
    this.adapters.set('paper', paper);
    for (const adapter of adapters) this.adapters.set(adapter.exchange, adapter);
  }

  async snapshot(): Promise<TradingWebSnapshot> {
    const [overview, analytics, strategies, accounts, routes, intents, activity] = await Promise.all([
      getTradingOverview(),
      getTradingAnalytics(),
      listTradingStrategies(),
      listTradingAccounts(),
      listTradingRoutes(),
      listTradingIntents(200),
      listTradingActivity(200),
    ]);
    return {
      overview,
      analytics,
      strategies,
      accounts: await Promise.all(accounts.map(async ({ credentialRef: _credentialRef, ...account }) => ({
        ...account,
        credentials: account.exchange === 'paper'
          ? { configured: true, exchange: null, updatedAt: account.createdAt }
          : await this.credentials.status(account.id),
      }))),
      routes,
      intents,
      activity,
      confirmations: { live: LIVE_CONFIRMATION, emergencyFlatten: FLATTEN_CONFIRMATION },
    };
  }

  async portfolioSnapshot(forceRefresh = false): Promise<TradingPortfolioSnapshot> {
    const now = Date.now();
    if (!forceRefresh && this.portfolioCache && this.portfolioCache.expiresAt > now) {
      return { ...this.portfolioCache.value, cached: true };
    }
    if (this.portfolioRefresh) return this.portfolioRefresh;
    this.portfolioRefresh = this.collectPortfolioSnapshot();
    try {
      const value = await this.portfolioRefresh;
      this.portfolioCache = { value, expiresAt: Date.now() + 60_000 };
      return value;
    } finally {
      this.portfolioRefresh = null;
    }
  }

  private async collectPortfolioSnapshot(): Promise<TradingPortfolioSnapshot> {
    const accounts = await listTradingAccounts();
    const observedAt = Date.now();
    const snapshots = await Promise.all(accounts.map(async (account): Promise<TradingPortfolioAccountSnapshot> => {
      const base = {
        accountId: account.id,
        name: account.name,
        exchange: account.exchange,
        mode: account.mode,
        enabled: account.enabled,
        status: account.status,
        reportingCurrency: account.exchange === 'paper' ? 'QUOTE' as const
          : account.exchange === 'hyperliquid' ? 'USDC' as const : 'USD' as const,
      };
      if (!['ready', 'disabled'].includes(account.status)) {
        return { ...base, equity: null, availableBalance: null, unrealizedPnl: null, marginUsed: null, observedAt: null, error: 'Account is not verified.' };
      }
      try {
        const snapshot = await this.requiredAdapter(account.exchange).accountSnapshot(account);
        return {
          ...base,
          equity: decimal(snapshot.equity, { positive: true }),
          availableBalance: decimal(snapshot.availableBalance),
          unrealizedPnl: snapshot.unrealizedPnl ? signedDecimal(snapshot.unrealizedPnl) : '0',
          marginUsed: snapshot.marginUsed ? decimal(snapshot.marginUsed) : '0',
          observedAt: Date.now(),
          error: null,
        };
      } catch (error: any) {
        return {
          ...base,
          equity: null,
          availableBalance: null,
          unrealizedPnl: null,
          marginUsed: null,
          observedAt: null,
          error: error?.message || String(error),
        };
      }
    }));
    return { accounts: snapshots, observedAt, cached: false };
  }

  createStrategy(payload: any) {
    return createTradingStrategyDraft({
      strategyId: payload.strategyId ? identifier(payload.strategyId, 'Strategy identifier', 64) : undefined,
      name: identifier(payload.name, 'Strategy name', 80),
      description: typeof payload.description === 'string' ? payload.description : '',
      configuration: payload.configuration,
    });
  }

  updateStrategy(payload: any) {
    return updateTradingStrategyDraft(identifier(payload.id, 'Strategy version identifier', 64), {
      name: identifier(payload.name, 'Strategy name', 80),
      description: typeof payload.description === 'string' ? payload.description : '',
      configuration: payload.configuration,
    });
  }

  publishStrategy(id: unknown) {
    return publishTradingStrategyVersion(identifier(id, 'Strategy version identifier', 64));
  }

  archiveStrategy(id: unknown) {
    return archiveTradingStrategyVersion(identifier(id, 'Strategy version identifier', 64));
  }

  removeStrategy(id: unknown) {
    return deleteTradingStrategyVersion(identifier(id, 'Strategy version identifier', 64));
  }

  async createAccount(payload: any): Promise<TradingAccount> {
    const exchange = payload.exchange as TradingExchange;
    const mode = payload.mode as TradingAccountMode;
    const account = await createTradingAccount({
      name: identifier(payload.name, 'Account name', 80),
      exchange,
      mode,
      credentialRef: exchange === 'paper' ? undefined : 'managed-secret',
    });
    if (exchange === 'paper') return account;
    try {
      await this.credentials.set(account.id, this.credentialsFromPayload(exchange, payload.credentials));
      return await this.verifyAccount(account.id, true);
    } catch (error) {
      await this.credentials.remove(account.id).catch(() => undefined);
      await deleteTradingAccount(account.id).catch(() => undefined);
      throw error;
    }
  }

  async replaceAccountCredentials(payload: any): Promise<TradingAccount> {
    const account = await this.requiredAccount(payload.id);
    if (account.exchange === 'paper') throw new Error('Paper accounts do not have exchange credentials.');
    await updateTradingAccountState(account.id, { status: 'unverified', enabled: false });
    await this.credentials.set(account.id, this.credentialsFromPayload(account.exchange, payload.credentials));
    return this.verifyAccount(account.id, true);
  }

  async verifyAccount(id: unknown, enableOnSuccess = false): Promise<TradingAccount> {
    const account = await this.requiredAccount(id);
    if (account.exchange === 'paper') {
      return updateTradingAccountState(account.id, { status: 'ready', enabled: true, verifiedAt: Date.now() });
    }
    const adapter = this.requiredAdapter(account.exchange);
    if (!adapter.verifyAccount) throw new Error(`The ${account.exchange} adapter cannot verify credentials.`);
    try {
      const result = await adapter.verifyAccount(account);
      if (!result.verified) throw new Error('Exchange rejected account verification.');
      return updateTradingAccountState(account.id, {
        status: 'ready',
        enabled: enableOnSuccess || account.enabled,
        error: null,
        verifiedAt: Date.now(),
      });
    } catch (error: any) {
      await updateTradingAccountState(account.id, {
        status: 'error', enabled: false, error: error?.message || String(error), verifiedAt: null,
      });
      throw error;
    }
  }

  async setAccountEnabled(id: unknown, enabledValue: unknown): Promise<TradingAccount> {
    const account = await this.requiredAccount(id);
    const enabled = boolean(enabledValue, 'Account enabled state');
    if (enabled && account.status === 'disabled') return this.verifyAccount(account.id, true);
    if (enabled && account.status !== 'ready') throw new Error('Only a successfully verified account can be enabled.');
    if (!enabled) {
      await this.engine.cancelOpenEntries(account.id);
      await this.engine.reconcileAccount(account.id);
      const managed = await getDatabase().get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM trading_positions
         WHERE account_id = ? AND status IN ('opening', 'open', 'closing', 'emergency')`,
        [account.id],
      );
      if (Number(managed?.count || 0) > 0) {
        throw new Error('Account cannot be disabled while it owns a managed position. Disable its routes or emergency-flatten first.');
      }
    }
    return updateTradingAccountState(account.id, {
      status: enabled ? 'ready' : 'disabled',
      enabled,
      error: account.lastError,
      verifiedAt: account.lastVerifiedAt,
    });
  }

  async removeAccount(id: unknown): Promise<void> {
    const account = await this.requiredAccount(id);
    const remote = await this.requiredAdapter(account.exchange).openState(account);
    this.assertNoRemoteExposure(remote);
    if (!await deleteTradingAccount(account.id)) throw new Error('Trading account does not exist.');
    if (account.exchange !== 'paper') await this.credentials.remove(account.id);
  }

  setRoute(payload: any) {
    return setTradingRoute({
      channelId: identifier(payload.channelId, 'Channel identifier'),
      strategyVersionId: identifier(payload.strategyVersionId, 'Strategy version identifier', 64),
      accountId: identifier(payload.accountId, 'Account identifier', 64),
      enabled: boolean(payload.enabled, 'Route enabled state'),
    });
  }

  removeRoute(channelId: unknown) {
    return deleteTradingRoute(identifier(channelId, 'Channel identifier'));
  }

  async setRuntime(payload: any) {
    const action = identifier(payload.action, 'Runtime action', 40);
    if (action === 'execution') {
      const enabled = boolean(payload.enabled, 'Execution enabled state');
      if (enabled) {
        const overview = await getTradingOverview();
        if (overview.runtime.killSwitchActive) throw new Error('Execution cannot start while the kill switch is active.');
        if (overview.enabledRouteCount < 1) throw new Error('Execution requires at least one enabled channel route.');
        await this.reconcileEnabledAccounts();
      }
      return updateTradingRuntimeState({ executionEnabled: enabled });
    }
    if (action === 'live') {
      const enabled = boolean(payload.enabled, 'Live trading enabled state');
      if (enabled) {
        if (payload.confirmation !== LIVE_CONFIRMATION) throw new Error(`Live trading requires the exact confirmation '${LIVE_CONFIRMATION}'.`);
        const live = (await listTradingAccounts()).filter(account => account.mode === 'live' && account.enabled && account.status === 'ready');
        if (live.length < 1) throw new Error('Live trading requires at least one enabled, verified live account.');
        for (const account of live) await this.engine.reconcileAccount(account.id);
      }
      return updateTradingRuntimeState({ liveTradingEnabled: enabled });
    }
    if (action === 'kill-switch') {
      const active = boolean(payload.active, 'Kill switch state');
      if (active) {
        const reason = identifier(payload.reason, 'Kill switch reason', 300);
        return updateTradingRuntimeState({ executionEnabled: false, killSwitchActive: true, killSwitchReason: reason });
      }
      await this.reconcileEnabledAccounts();
      return updateTradingRuntimeState({ killSwitchActive: false, killSwitchReason: null });
    }
    throw new Error('Unsupported trading runtime action.');
  }

  async configurePaper(payload: any): Promise<void> {
    const account = await this.requiredAccount(payload.accountId);
    if (account.exchange !== 'paper') throw new Error('Paper configuration requires a paper account.');
    if (payload.equity !== undefined) await this.paper.setBalance(account.id, payload.equity, payload.availableBalance ?? payload.equity);
    if (payload.market) {
      const market = payload.market as Omit<TradingMarketSnapshot, 'observedAt'>;
      await this.paper.setMarket(account.id, market);
    }
  }

  async reconcile(id?: unknown): Promise<void> {
    if (id) await this.engine.reconcileAccount(identifier(id, 'Account identifier', 64));
    else await this.reconcileEnabledAccounts();
  }

  cancelEntries(id?: unknown) {
    return this.engine.cancelOpenEntries(id ? identifier(id, 'Account identifier', 64) : undefined);
  }

  async emergencyFlatten(payload: any): Promise<number> {
    if (payload.confirmation !== FLATTEN_CONFIRMATION) {
      throw new Error(`Emergency flatten requires the exact confirmation '${FLATTEN_CONFIRMATION}'.`);
    }
    await updateTradingRuntimeState({ executionEnabled: false, killSwitchActive: true, killSwitchReason: 'Operator emergency flatten' });
    const accountId = payload.accountId ? identifier(payload.accountId, 'Account identifier', 64) : undefined;
    if (accountId) await this.engine.reconcileAccount(accountId);
    else await this.reconcileEnabledAccounts();
    return this.engine.emergencyFlattenManaged(accountId);
  }

  acknowledgeRisk(id: unknown) {
    return acknowledgeTradingRiskEvent(identifier(id, 'Risk event identifier', 64));
  }

  async assertFactoryResetSafe(): Promise<void> {
    await updateTradingRuntimeState({ executionEnabled: false, liveTradingEnabled: false });
    await this.engine.cancelOpenEntries();
    const accounts = (await listTradingAccounts()).filter(account => account.exchange !== 'paper');
    for (const account of accounts) {
      const remote = await this.requiredAdapter(account.exchange).openState(account);
      this.assertNoRemoteExposure(remote);
    }
    const localExposure = await getDatabase().get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM trading_positions
       WHERE status IN ('opening', 'open', 'closing', 'emergency') AND quantity <> '0'`,
    );
    if (Number(localExposure?.count || 0) > 0) throw new Error('Factory reset refused while managed positions remain open.');
  }

  private async requiredAccount(id: unknown): Promise<TradingAccount> {
    const account = await getTradingAccount(identifier(id, 'Account identifier', 64));
    if (!account) throw new Error('Trading account does not exist.');
    return account;
  }

  private requiredAdapter(exchange: TradingExchange): VerifiableAdapter {
    const adapter = this.adapters.get(exchange);
    if (!adapter) throw new Error(`No ${exchange} adapter is configured.`);
    return adapter;
  }

  private credentialsFromPayload(exchange: TradingExchange, input: any): TradingCredentials {
    if (exchange === 'hyperliquid') {
      return { exchange, privateKey: input?.privateKey, walletAddress: input?.walletAddress };
    }
    if (exchange === 'bybit') return { exchange, apiKey: input?.apiKey, apiSecret: input?.apiSecret };
    throw new Error('Paper accounts do not accept credentials.');
  }

  private async reconcileEnabledAccounts(): Promise<void> {
    const accounts = (await listTradingAccounts()).filter(account => account.enabled && account.status === 'ready');
    if (accounts.length < 1) throw new Error('No enabled, verified trading account is available.');
    for (const account of accounts) await this.engine.reconcileAccount(account.id);
  }

  private assertNoRemoteExposure(remote: ExchangeOpenState): void {
    const openOrders = remote.orders.filter(order => ['open', 'partially_filled', 'unknown'].includes(order.status));
    if (openOrders.length > 0 || remote.positions.length > 0) {
      throw new Error('Operation refused while the exchange reports open orders or positions.');
    }
  }
}

export type TradingStrategyConfigurationInput = StrategyConfiguration;
