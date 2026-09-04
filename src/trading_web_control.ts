import { getDatabase, withDatabaseTransaction } from './db.js';
import { CcxtExchangeAdapter } from './ccxt_exchange.js';
import {
  ExchangeCatalogClient,
  type ExchangeCatalog,
  type ExchangeCatalogEntry,
} from './exchange_catalog.js';
import { PaperExchangeAdapter } from './paper_exchange.js';
import type { TradingCredentialStore, TradingCredentials } from './trading_credentials.js';
import { TradingEngine } from './trading_engine.js';
import type { TradingMutationContext } from './trading_mutation_coordinator.js';
import { assertTradingSafety, evaluateTradingSafety, type TradingSafetyProof } from './trading_safety_proof.js';
import { collectAccountReleaseEvidence } from './trading_safety_repository.js';
import { GLOBAL_KILL_RELEASE_CONFIRMATION, releaseGlobalTradingKillSwitch } from './trading_runtime_release.js';
import {
  acknowledgeTradingRiskEvent,
  archiveSignalContractVersion,
  archiveTradingStrategyVersion,
  createSignalContract,
  createSignalContractDraftVersion,
  createTradingSignalSchema,
  createTradingAccount,
  createTradingStrategyDraft,
  deleteTradingAccount,
  deleteTradingRoute,
  deleteTradingSignalSchema,
  deleteSignalContractDraft,
  deleteSignalContractVersion,
  deleteTradingStrategyVersion,
  getTradingAccount,
  getTradingAnalytics,
  getTradingOverview,
  listTradingAccounts,
  listTradingActivity,
  listTradingIntents,
  listTradingRoutes,
  listTradingSignalSchemas,
  listSignalContracts,
  listTradingStrategies,
  publishTradingStrategyVersion,
  publishSignalContractVersion,
  setTradingRoute,
  updateTradingAccountState,
  updateTradingAccountConfiguration,
  updateTradingRuntimeState,
  updateTradingSignalSchema,
  updateSignalContractDraft,
  updateTradingStrategyDraft,
  duplicateSignalContract,
} from './trading_repository.js';
import { assertSignalGrounded, validateSignalXml } from './signal_schema.js';
import { validateSignalContractDefinition } from './signal_contract.js';
import {
  deleteChannelRiskPolicy,
  getWorkflowAdaptiveRiskAnalytics,
  listChannelRiskEvaluations,
  listChannelRiskPolicies,
  upsertChannelRiskPolicy,
} from './trading_channel_risk.js';
import {
  getTradingExecutionAnalytics,
  getChannelPerformanceAnalytics,
  listTradingEquityPoints,
  recordTradingEquitySnapshot,
} from './trading_telemetry.js';
import { decimal, signedDecimal } from './trading_decimal.js';
import { listExchangeStreamStates } from './exchange_stream_repository.js';
import { listTradingAccountIncidents } from './trading_incidents.js';
import {
  archiveWorkflowResource,
  createWorkflowResourceDraft,
  deleteWorkflowResourceDraft,
  publishWorkflowResource,
  saveWorkflowRevision,
  updateWorkflowResourceDraft,
  listWorkflowFallbackRuns,
} from './workflow_repository.js';
import type {
  ExchangeOpenState,
  TradingAccount,
  TradingAccountMode,
  TradingExchange,
  TradingExchangeAdapter,
  TradingMarketSnapshot,
} from './trading_types.js';
import { tradingExchangeId } from './trading_types.js';

type VerifiableAdapter = TradingExchangeAdapter & {
  verifyAccount?: (account: TradingAccount) => Promise<{
    verified: boolean;
    equity: string;
    externalAccountId: string;
    credentialGeneration: string;
    capabilities?: Record<string, unknown>;
  }>;
};

export interface TradingEntryRuntimeControl {
  enableEntries(): Promise<void>;
  disableEntries(): void;
}

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

function externalAccountIdentity(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error('Exchange account verification did not return a stable external account identity.');
  }
  return value;
}

function verifiedCredentialGeneration(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error('Exchange verification did not return a credential generation.');
  }
  return value;
}

export interface TradingWebSnapshot {
  overview: Awaited<ReturnType<typeof getTradingOverview>>;
  analytics: Awaited<ReturnType<typeof getTradingAnalytics>>;
  strategies: Awaited<ReturnType<typeof listTradingStrategies>>;
  signalSchemas: Awaited<ReturnType<typeof listTradingSignalSchemas>>;
  signalContracts: Awaited<ReturnType<typeof listSignalContracts>>;
  channelRiskPolicies: Awaited<ReturnType<typeof listChannelRiskPolicies>>;
  channelRiskEvaluations: Awaited<ReturnType<typeof listChannelRiskEvaluations>>;
  workflowAdaptiveRisk: Awaited<ReturnType<typeof getWorkflowAdaptiveRiskAnalytics>>;
  executionAnalytics: Awaited<ReturnType<typeof getTradingExecutionAnalytics>>;
  channelAnalytics: Awaited<ReturnType<typeof getChannelPerformanceAnalytics>>;
  equityHistory: Awaited<ReturnType<typeof listTradingEquityPoints>>;
  accounts: Array<Omit<TradingAccount, 'credentialRef'> & {
    credentials: Awaited<ReturnType<TradingCredentialStore['status']>>;
  }>;
  routes: Awaited<ReturnType<typeof listTradingRoutes>>;
  intents: Awaited<ReturnType<typeof listTradingIntents>>;
  activity: Awaited<ReturnType<typeof listTradingActivity>>;
  exchangeStreams: Awaited<ReturnType<typeof listExchangeStreamStates>>;
  accountIncidents: Awaited<ReturnType<typeof listTradingAccountIncidents>>;
  fallbackRuns: Awaited<ReturnType<typeof listWorkflowFallbackRuns>>;
  confirmations: { live: string; emergencyFlatten: string; globalKillSwitch: string };
}

export interface TradingPortfolioAccountSnapshot {
  accountId: string;
  name: string;
  exchange: TradingExchange;
  mode: TradingAccountMode;
  enabled: boolean;
  status: string;
  reportingCurrency: string;
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

function reportingCurrency(account: TradingAccount): string {
  if (account.exchange === 'paper') return 'QUOTE';
  const value = account.capabilities?.reportingCurrency;
  return typeof value === 'string' && /^[A-Z0-9]{2,12}$/.test(value) ? value : 'QUOTE';
}

type CatalogAccess = Pick<ExchangeCatalogClient, 'browserCatalog' | 'probe'>;
type AdapterFactory = (exchange: TradingExchange) => VerifiableAdapter;

export class TradingWebControl {
  private readonly adapters = new Map<TradingExchange, VerifiableAdapter>();
  private portfolioCache: { value: TradingPortfolioSnapshot; expiresAt: number } | null = null;
  private portfolioRefresh: Promise<TradingPortfolioSnapshot> | null = null;
  private entryRuntime: TradingEntryRuntimeControl | null;

  constructor(
    private readonly credentials: TradingCredentialStore,
    private readonly paper: PaperExchangeAdapter,
    adapters: VerifiableAdapter[],
    private readonly engine: TradingEngine,
    entryRuntime: TradingEntryRuntimeControl | null = null,
    private readonly catalog: CatalogAccess = new ExchangeCatalogClient(credentials),
    private readonly adapterFactory: AdapterFactory = exchange => new CcxtExchangeAdapter(exchange, credentials),
  ) {
    this.entryRuntime = entryRuntime;
    this.adapters.set('paper', paper);
    for (const adapter of adapters) this.adapters.set(adapter.exchange, adapter);
  }

  exchangeCatalog(): Promise<ExchangeCatalog> {
    return this.catalog.browserCatalog();
  }

  probeExchange(exchange: unknown): Promise<ExchangeCatalogEntry> {
    return this.catalog.probe(tradingExchangeId(exchange));
  }

  attachEntryRuntime(runtime: TradingEntryRuntimeControl): void {
    if (this.entryRuntime && this.entryRuntime !== runtime) {
      throw new Error('Trading entry runtime is already attached.');
    }
    this.entryRuntime = runtime;
  }

  private requiredEntryRuntime(): TradingEntryRuntimeControl {
    if (!this.entryRuntime) throw new Error('Trading entry runtime is unavailable.');
    return this.entryRuntime;
  }

  async snapshot(): Promise<TradingWebSnapshot> {
    const [
      overview, analytics, strategies, signalSchemas, signalContracts, channelRiskPolicies,
      channelRiskEvaluations, workflowAdaptiveRisk, executionAnalytics, channelAnalytics, equityHistory, accounts, routes, intents, activity,
      exchangeStreams, accountIncidents, fallbackRuns,
    ] = await Promise.all([
      getTradingOverview(),
      getTradingAnalytics(),
      listTradingStrategies(),
      listTradingSignalSchemas(),
      listSignalContracts(),
      listChannelRiskPolicies(),
      listChannelRiskEvaluations(),
      getWorkflowAdaptiveRiskAnalytics(),
      getTradingExecutionAnalytics(),
      getChannelPerformanceAnalytics(),
      listTradingEquityPoints(),
      listTradingAccounts(),
      listTradingRoutes(),
      listTradingIntents(200),
      listTradingActivity(200),
      listExchangeStreamStates(),
      listTradingAccountIncidents({ limit: 200 }),
      listWorkflowFallbackRuns(200),
    ]);
    return {
      overview,
      analytics,
      strategies,
      signalSchemas,
      signalContracts,
      channelRiskPolicies,
      channelRiskEvaluations,
      workflowAdaptiveRisk,
      executionAnalytics,
      channelAnalytics,
      equityHistory,
      accounts: await Promise.all(accounts.map(async ({ credentialRef: _credentialRef, ...account }) => ({
        ...account,
        credentials: account.exchange === 'paper'
          ? { configured: true, exchange: null, updatedAt: account.createdAt }
          : await this.credentials.status(account.id),
      }))),
      routes,
      intents,
      activity,
      exchangeStreams,
      accountIncidents,
      fallbackRuns,
      confirmations: { live: LIVE_CONFIRMATION, emergencyFlatten: FLATTEN_CONFIRMATION, globalKillSwitch: GLOBAL_KILL_RELEASE_CONFIRMATION },
    };
  }

  async portfolioSnapshot(forceRefresh = false): Promise<TradingPortfolioSnapshot> {
    const now = Date.now();
    if (!forceRefresh && this.portfolioCache && this.portfolioCache.expiresAt > now) {
      return { ...this.portfolioCache.value, cached: true };
    }
    if (this.portfolioRefresh !== null) return this.portfolioRefresh;
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
        reportingCurrency: reportingCurrency(account),
      };
      if (!['ready', 'disabled'].includes(account.status)) {
        return { ...base, equity: null, availableBalance: null, unrealizedPnl: null, marginUsed: null, observedAt: null, error: 'Account is not verified.' };
      }
      try {
        const snapshot = await this.requiredAdapter(account.exchange).accountSnapshot(account);
        const snapshotObservedAt = Date.now();
        await recordTradingEquitySnapshot(account.id, snapshot, snapshotObservedAt);
        return {
          ...base,
          equity: decimal(snapshot.equity, { positive: true }),
          availableBalance: decimal(snapshot.availableBalance),
          unrealizedPnl: snapshot.unrealizedPnl ? signedDecimal(snapshot.unrealizedPnl) : '0',
          marginUsed: snapshot.marginUsed ? decimal(snapshot.marginUsed) : '0',
          observedAt: snapshotObservedAt,
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

  createSignalSchema(payload: any) {
    return createTradingSignalSchema({
      id: payload.id,
      name: payload.name,
      description: payload.description,
      parserSchema: payload.parserSchema,
      contractVersionId: payload.contractVersionId,
      definition: payload.definition,
      templateName: payload.templateName,
      enabled: payload.enabled,
    });
  }

  updateSignalSchema(payload: any) {
    return updateTradingSignalSchema(identifier(payload.id, 'Signal schema identifier', 40), {
      name: payload.name,
      description: payload.description,
      parserSchema: payload.parserSchema,
      contractVersionId: payload.contractVersionId,
      definition: payload.definition,
      templateName: payload.templateName,
      enabled: payload.enabled,
    });
  }

  removeSignalSchema(id: unknown) {
    return deleteTradingSignalSchema(identifier(id, 'Signal schema identifier', 40));
  }

  createSignalContract(payload: any) {
    return createSignalContract({
      id: payload.id,
      name: payload.name,
      description: payload.description,
      definition: payload.definition,
    });
  }

  createSignalContractVersion(payload: any) {
    return createSignalContractDraftVersion(payload.contractId, payload.sourceVersionId);
  }

  updateSignalContract(payload: any) {
    return updateSignalContractDraft({
      contractId: payload.contractId,
      versionId: payload.versionId,
      name: payload.name,
      description: payload.description,
      definition: payload.definition,
    });
  }

  duplicateSignalContract(payload: any) {
    return duplicateSignalContract({
      sourceVersionId: payload.sourceVersionId,
      id: payload.id,
      name: payload.name,
      description: payload.description,
    });
  }

  publishSignalContract(versionId: unknown) {
    return publishSignalContractVersion(versionId);
  }

  archiveSignalContract(versionId: unknown) {
    return archiveSignalContractVersion(versionId);
  }

  removeSignalContractDraft(versionId: unknown) {
    return deleteSignalContractDraft(versionId);
  }

  removeSignalContractVersion(versionId: unknown) {
    return deleteSignalContractVersion(versionId);
  }

  validateSignalContract(payload: any) {
    const definition = validateSignalContractDefinition(payload.definition);
    if (typeof payload.xml !== 'string') throw new Error('Signal XML must be a string.');
    const validated = validateSignalXml(
      payload.xml,
      undefined,
      { id: 'contract-preview', parserSchema: 'standard', contractDefinition: definition },
    );
    if (typeof payload.sourceText === 'string' && payload.sourceText.trim()) {
      assertSignalGrounded(validated, payload.sourceText);
    }
    return validated;
  }

  setChannelRiskPolicy(payload: any) {
    return upsertChannelRiskPolicy(payload);
  }

  removeChannelRiskPolicy(channelId: unknown) {
    return deleteChannelRiskPolicy(channelId);
  }

  async createAccount(payload: any): Promise<TradingAccount> {
    const exchange = tradingExchangeId(payload.exchange);
    const mode = payload.mode as TradingAccountMode;
    if (exchange === 'paper') {
      return createTradingAccount({
        name: identifier(payload.name, 'Account name', 80),
        exchange,
        mode,
        initialBalance: payload.initialBalance,
        maxConcurrentPositions: payload.maxConcurrentPositions,
      });
    }
    const catalogEntry = await this.certifiedCatalogEntry(exchange, mode);
    const credentials = this.credentialsFromPayload(catalogEntry, payload.credentials);
    this.ensureAdapter(exchange);
    const account = await createTradingAccount({
      name: identifier(payload.name, 'Account name', 80),
      exchange,
      mode,
      credentialRef: 'managed-secret',
      maxConcurrentPositions: payload.maxConcurrentPositions,
    });
    try {
      await this.credentials.set(account.id, credentials);
      return await this.verifyAccount(account.id, true);
    } catch (error) {
      await this.credentials.remove(account.id).catch(() => undefined);
      await deleteTradingAccount(account.id).catch(() => undefined);
      throw error;
    }
  }

  async replaceAccountCredentials(payload: any): Promise<TradingAccount> {
    const accountId = identifier(payload.id, 'Account identifier', 64);
    this.engine.mutations.fenceEntries();
    return this.engine.mutations.run(accountId, context => this.replaceAccountCredentialsOwned(payload, context));
  }

  private async replaceAccountCredentialsOwned(payload: any, context: TradingMutationContext): Promise<TradingAccount> {
    let account = await this.requiredAccount(payload.id);
    if (account.exchange === 'paper') throw new Error('Paper accounts do not have exchange credentials.');
    const catalogEntry = await this.certifiedCatalogEntry(account.exchange, account.mode);
    const adapter = this.requiredAdapter(account.exchange);
    if (!adapter.verifyAccount) throw new Error(`The ${account.exchange} adapter cannot verify credentials.`);

    // Credential rotation is a maintenance operation, never a live-trading
    // operation. Leave the global kill switch engaged for explicit operator
    // review after a successful rotation.
    this.entryRuntime?.disableEntries();
    await updateTradingRuntimeState({
      executionEnabled: false,
      killSwitchActive: true,
      killSwitchReason: `Credential rotation requested for account ${account.id}`,
    });
    await updateTradingAccountState(account.id, { status: 'unverified', enabled: false });

    // Bind legacy rows before any cancel as well as before evaluating a candidate.
    const oldVerification = await adapter.verifyAccount(account);
    if (!oldVerification.verified) throw new Error('Exchange rejected existing account verification.');
    const boundIdentity = externalAccountIdentity(oldVerification.externalAccountId);
    if (account.externalAccountId && account.externalAccountId !== boundIdentity) {
      throw new Error('Existing credentials resolve to a different external exchange account.');
    }
    account = await updateTradingAccountState(account.id, {
      externalAccountId: boundIdentity,
      credentialGeneration: verifiedCredentialGeneration(oldVerification.credentialGeneration),
      status: 'unverified',
      enabled: false,
      error: null,
      verifiedAt: Date.now(),
    });
    await this.engine.cancelOpenEntries(account.id, context);
    await this.engine.reconcileAccount(account.id, { mutation: context });
    const oldState = await adapter.openState(account);
    const activeOrders = oldState.orders.filter(order => !['filled', 'cancelled', 'rejected'].includes(order.status));
    if (activeOrders.length > 0 || oldState.positions.length > 0) {
      throw new Error('Credentials cannot be replaced while the exchange account has open orders or positions.');
    }

    const candidateId = await this.credentials.stageCandidate(
      this.credentialsFromPayload(catalogEntry, payload.credentials),
    );
    try {
      const candidate = { ...account, id: candidateId, credentialRef: 'managed-secret' };
      const result = await adapter.verifyAccount(candidate);
      if (!result.verified) throw new Error('Exchange rejected candidate account verification.');
      const candidateIdentity = externalAccountIdentity(result.externalAccountId);
      if (candidateIdentity !== boundIdentity) {
        throw new Error('Candidate credentials belong to a different external exchange account.');
      }
      const candidateGeneration = verifiedCredentialGeneration(result.credentialGeneration);
      await this.credentials.promoteCandidate(candidateId, account.id);
      return updateTradingAccountState(account.id, {
        externalAccountId: boundIdentity,
        credentialGeneration: candidateGeneration,
        status: 'ready',
        enabled: false,
        error: null,
        verifiedAt: Date.now(),
      });
    } catch (error) {
      await this.credentials.discardCandidate(candidateId).catch(() => undefined);
      await updateTradingAccountState(account.id, {
        externalAccountId: boundIdentity,
        status: 'ready',
        enabled: false,
        error: error instanceof Error ? error.message : String(error),
        verifiedAt: Date.now(),
      });
      throw error;
    }
  }

  async verifyAccount(id: unknown, enableOnSuccess = false, context?: TradingMutationContext): Promise<TradingAccount> {
    const accountId = identifier(id, 'Account identifier', 64);
    return this.engine.mutations.run(accountId, () => this.verifyAccountOwned(accountId, enableOnSuccess), context);
  }

  private async verifyAccountOwned(id: string, enableOnSuccess: boolean): Promise<TradingAccount> {
    const account = await this.requiredAccount(id);
    if (account.exchange === 'paper') {
      return updateTradingAccountState(account.id, { status: 'ready', enabled: true, verifiedAt: Date.now() });
    }
    const adapter = this.requiredAdapter(account.exchange);
    if (!adapter.verifyAccount) throw new Error(`The ${account.exchange} adapter cannot verify credentials.`);
    try {
      const result = await adapter.verifyAccount(account);
      if (!result.verified) throw new Error('Exchange rejected account verification.');
      const externalAccountId = externalAccountIdentity(result.externalAccountId);
      if (account.externalAccountId && account.externalAccountId !== externalAccountId) {
        throw new Error('Credentials resolve to a different external exchange account.');
      }
      const verified = await updateTradingAccountState(account.id, {
        externalAccountId,
        credentialGeneration: verifiedCredentialGeneration(result.credentialGeneration),
        status: 'ready',
        enabled: enableOnSuccess || account.enabled,
        error: null,
        verifiedAt: Date.now(),
      });
      if (result.capabilities) {
        return updateTradingAccountConfiguration(verified.id, { capabilities: result.capabilities });
      }
      return verified;
    } catch (error: any) {
      await updateTradingAccountState(account.id, {
        status: 'error', enabled: false, error: error?.message || String(error), verifiedAt: null,
      });
      throw error;
    }
  }

  async setAccountEnabled(id: unknown, enabledValue: unknown): Promise<TradingAccount> {
    const accountId = identifier(id, 'Account identifier', 64);
    const enabled = boolean(enabledValue, 'Account enabled state');
    if (!enabled) this.engine.mutations.fenceEntries(accountId);
    return this.engine.mutations.run(accountId, context => this.setAccountEnabledOwned(accountId, enabled, context));
  }

  private async setAccountEnabledOwned(id: string, enabledValue: boolean, context: TradingMutationContext): Promise<TradingAccount> {
    const account = await this.requiredAccount(id);
    const enabled = boolean(enabledValue, 'Account enabled state');
    if (enabled && account.status === 'disabled') return this.verifyAccount(account.id, true, context);
    if (enabled && account.status !== 'ready') throw new Error('Only a successfully verified account can be enabled.');
    if (!enabled) {
      await this.engine.cancelOpenEntries(account.id, context);
      await this.engine.reconcileAccount(account.id, { mutation: context });
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

  async configureAccount(payload: any): Promise<TradingAccount> {
    const accountId = identifier(payload.id, 'Account identifier', 64);
    const release = payload.killSwitchActive === true ? this.engine.mutations.holdEntries(accountId) : undefined;
    try {
      return await this.engine.mutations.run(accountId, context => this.configureAccountOwned(payload, accountId, context));
    } finally {
      release?.();
    }
  }

  private async configureAccountOwned(payload: any, accountId: string, context: TradingMutationContext): Promise<TradingAccount> {
    const current = await this.requiredAccount(accountId);
    if (current.killSwitchActive && payload.killSwitchActive === false) {
      throw new Error('Account kill switches require the protected kill-switch release confirmation operation.');
    }
    const updated = await updateTradingAccountConfiguration(
      accountId,
      {
        maxConcurrentPositions: payload.maxConcurrentPositions,
        killSwitchActive: payload.killSwitchActive,
        killSwitchReason: payload.killSwitchReason,
      },
    );
    if (payload.killSwitchActive === true) await this.engine.cancelOpenEntries(accountId, context);
    return updated;
  }

  async releaseAccountKillSwitch(payload: any): Promise<{
    account: TradingAccount;
    reconciliations: number;
    proof: TradingSafetyProof;
  }> {
    const accountId = identifier(payload.id, 'Account identifier', 64);
    const epoch = this.engine.mutations.entryEpoch(accountId);
    return this.engine.mutations.run(accountId, context => this.releaseAccountKillSwitchOwned(payload, accountId, context, epoch));
  }

  private async releaseAccountKillSwitchOwned(payload: any, accountId: string, context: TradingMutationContext, epoch: string): Promise<{
    account: TradingAccount; reconciliations: number; proof: TradingSafetyProof;
  }> {
    const confirmation = identifier(payload.confirmation, 'Account kill-switch release confirmation', 64);
    if (confirmation !== 'RELEASE ACCOUNT KILL SWITCH') {
      throw new Error('Explicit account kill-switch release confirmation required.');
    }
    const current = await this.requiredAccount(accountId);
    if (!current.killSwitchActive) throw new Error('Account kill switch is not active.');
    if (!current.enabled || current.status !== 'ready') {
      throw new Error('Account must be enabled and verified before its kill switch can be released.');
    }
    const requestedAt = Date.now();
    await this.engine.reconcileAccount(accountId, { force: true, mutation: context });
    const balanceStartedAt = Date.now();
    const balance = await this.requiredAdapter(current.exchange).accountSnapshot(current);
    const balanceCompletedAt = Date.now();
    const reconciled = await this.engine.reconcileAccount(accountId, { force: true, mutation: context });
    if (!reconciled) throw new Error('Forced reconciliation did not return safety evidence.');
    return withDatabaseTransaction(async () => {
      this.engine.mutations.assertEpoch(context, epoch);
      const evidence = await collectAccountReleaseEvidence({ current: await this.requiredAccount(accountId), reconciled,
        verificationAccount: current, epoch, requestedAt, balance, balanceStartedAt, balanceCompletedAt });
      const proof = evaluateTradingSafety(evidence, 'accountRelease');
      assertTradingSafety(proof);
      // The proof and write share the transaction. An operator fence still wins at the final boundary.
      this.engine.mutations.assertEpoch(context, epoch);
      const account = await updateTradingAccountConfiguration(accountId, { killSwitchActive: false, killSwitchReason: null });
      const finalEvidence = await collectAccountReleaseEvidence({ current: account,
        reconciled: { ...reconciled, accountVersion: reconciled.accountVersion + 1 },
        verificationAccount: current, epoch, requestedAt, balance, balanceStartedAt, balanceCompletedAt });
      assertTradingSafety(evaluateTradingSafety(finalEvidence, 'accountRelease'));
      this.engine.mutations.assertEpoch(context, epoch);
      return { account, reconciliations: 2, proof };
    });
  }

  async removeAccount(id: unknown): Promise<void> {
    const accountId = identifier(id, 'Account identifier', 64);
    this.engine.mutations.fenceEntries(accountId);
    return this.engine.mutations.run(accountId, () => this.removeAccountOwned(accountId));
  }

  private async removeAccountOwned(id: string): Promise<void> {
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
    if (!['execution', 'live', 'kill-switch'].includes(action)) throw new Error('Unsupported trading runtime action.');
    const lowering = action === 'kill-switch'
      ? boolean(payload.active, 'Kill switch state')
      : !boolean(payload.enabled, 'Runtime enabled state');
    const release = lowering ? this.engine.mutations.holdEntries() : undefined;
    const epoch = this.engine.mutations.entryEpoch('@runtime');
    try {
      return await this.engine.mutations.run('@runtime', async context => {
        const assertAuthority = () => this.engine.mutations.assertEpoch(context, epoch);
        if (action === 'execution') return this.setExecutionRuntime(payload, assertAuthority);
        if (action === 'live') return this.setLiveRuntime(payload, assertAuthority);
        return this.setKillSwitchRuntime(payload, assertAuthority);
      });
    } finally {
      release?.();
    }
  }

  private async setExecutionRuntime(payload: any, assertAuthority: () => void) {
    const enabled = boolean(payload.enabled, 'Execution enabled state');
    if (!enabled) {
      this.engine.mutations.fenceEntries();
      this.entryRuntime?.disableEntries();
      return updateTradingRuntimeState({ executionEnabled: false });
    }
    const overview = await getTradingOverview();
    if (overview.runtime.killSwitchActive) throw new Error('Execution cannot start while the kill switch is active.');
    if (overview.enabledRouteCount < 1) throw new Error('Execution requires at least one enabled channel route.');
    const runtime = this.requiredEntryRuntime();
    await this.reconcileEnabledAccounts();
    assertAuthority();
    const state = await updateTradingRuntimeState({ executionEnabled: true });
    try {
      await runtime.enableEntries();
      return state;
    } catch (error) {
      runtime.disableEntries();
      await updateTradingRuntimeState({ executionEnabled: false });
      throw error;
    }
  }

  private async setLiveRuntime(payload: any, assertAuthority: () => void) {
    const enabled = boolean(payload.enabled, 'Live trading enabled state');
    if (!enabled) this.engine.mutations.fenceEntries();
    if (enabled) {
      if (payload.confirmation !== LIVE_CONFIRMATION) throw new Error(`Live trading requires the exact confirmation '${LIVE_CONFIRMATION}'.`);
      const live = (await listTradingAccounts()).filter(account => account.mode === 'live' && account.enabled && account.status === 'ready');
      if (live.length < 1) throw new Error('Live trading requires at least one enabled, verified live account.');
      for (const account of live) await this.engine.reconcileAccount(account.id);
      assertAuthority();
    }
    return updateTradingRuntimeState({ liveTradingEnabled: enabled });
  }

  private async setKillSwitchRuntime(payload: any, assertAuthority: () => void) {
    const active = boolean(payload.active, 'Kill switch state');
    if (active) {
      const reason = identifier(payload.reason, 'Kill switch reason', 300);
      this.engine.mutations.fenceEntries();
      this.entryRuntime?.disableEntries();
      const state = await updateTradingRuntimeState({ executionEnabled: false, killSwitchActive: true, killSwitchReason: reason });
      await this.engine.cancelOpenEntries();
      return state;
    }
    if (payload.confirmation !== GLOBAL_KILL_RELEASE_CONFIRMATION) {
      throw new Error(`Global kill-switch release requires the exact confirmation '${GLOBAL_KILL_RELEASE_CONFIRMATION}'.`);
    }
    return releaseGlobalTradingKillSwitch({ engine: this.engine, assertAuthority,
      accountSnapshot: account => this.requiredAdapter(account.exchange).accountSnapshot(account) });
  }

  async configurePaper(payload: any): Promise<void> {
    const accountId = identifier(payload.accountId, 'Account identifier', 64);
    return this.engine.mutations.run(accountId, () => this.configurePaperOwned(payload));
  }

  private async configurePaperOwned(payload: any): Promise<void> {
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
    this.engine.mutations.fenceEntries();
    this.entryRuntime?.disableEntries();
    await updateTradingRuntimeState({ executionEnabled: false, killSwitchActive: true, killSwitchReason: 'Operator emergency flatten' });
    const accountId = payload.accountId ? identifier(payload.accountId, 'Account identifier', 64) : undefined;
    // Persist the emergency request before reconciliation; an unresolved cancel must not discard it.
    return this.engine.emergencyFlattenManaged(accountId);
  }

  acknowledgeRisk(id: unknown) {
    return acknowledgeTradingRiskEvent(identifier(id, 'Risk event identifier', 64));
  }

  createWorkflowResource(payload: any) {
    return createWorkflowResourceDraft(payload);
  }

  updateWorkflowResource(payload: any) {
    return updateWorkflowResourceDraft(identifier(payload.id, 'Workflow resource version identifier', 64), payload);
  }

  publishWorkflowResource(id: unknown) {
    return publishWorkflowResource(identifier(id, 'Workflow resource version identifier', 64));
  }

  archiveWorkflowResource(id: unknown) {
    return archiveWorkflowResource(identifier(id, 'Workflow resource version identifier', 64));
  }

  deleteWorkflowResourceDraft(id: unknown) {
    return deleteWorkflowResourceDraft(identifier(id, 'Workflow resource version identifier', 64));
  }

  activateWorkflow(payload: any, actorId = 'control:workflow') {
    return saveWorkflowRevision({
      baseRevisionId: payload.baseRevisionId ?? null,
      graph: payload.graph,
      actorId,
      confirmation: payload.confirmation ?? null,
    });
  }

  async assertFactoryResetSafe(): Promise<void> {
    this.entryRuntime?.disableEntries();
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

  private ensureAdapter(exchangeValue: unknown): VerifiableAdapter {
    const exchange = tradingExchangeId(exchangeValue);
    if (exchange === 'paper') return this.paper;
    const existing = this.adapters.get(exchange);
    if (existing) return existing;
    const adapter = this.adapterFactory(exchange);
    if (adapter.exchange !== exchange) {
      throw new Error('Dynamic adapter factory returned a different exchange identifier.');
    }
    this.engine.registerAdapter(adapter);
    this.adapters.set(exchange, adapter);
    return adapter;
  }

  private async certifiedCatalogEntry(
    exchange: TradingExchange,
    mode: TradingAccountMode,
  ): Promise<ExchangeCatalogEntry> {
    const catalog = await this.catalog.browserCatalog();
    const entry = catalog.exchanges.find(candidate => candidate.id === exchange);
    if (!entry) throw new Error(`Exchange ${exchange} is not present in the installed CCXT catalog.`);
    if (entry.status !== 'certified') {
      throw new Error(`Exchange ${exchange} is not TSX certified and cannot create an account.`);
    }
    if (!entry.modes.includes(mode)) {
      throw new Error(`Account mode ${mode} is not certified for exchange ${exchange}.`);
    }
    return entry;
  }

  private credentialsFromPayload(entry: ExchangeCatalogEntry, input: any): TradingCredentials {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('Exchange credentials are required.');
    }
    const allowed = new Set(entry.credentialFields.map(field => field.id));
    const provided = Object.keys(input);
    const unexpected = provided.find(field => !allowed.has(field));
    if (unexpected) throw new Error(`Credential field ${unexpected} is not allowed for ${entry.id}.`);
    const values: Record<string, string> = {};
    for (const field of entry.credentialFields) {
      const value = input[field.id];
      if (field.required && (typeof value !== 'string' || !value.trim())) {
        throw new Error(`${field.label} is required.`);
      }
      if (value !== undefined) {
        if (typeof value !== 'string' || value.length > 4096 || /[\r\n\0]/.test(value)) {
          throw new Error(`${field.label} has an invalid format.`);
        }
        if (value.trim()) values[field.id] = value.trim();
      }
    }
    return { exchange: entry.id, credentials: values };
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
