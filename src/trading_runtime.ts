import { getDatabase } from './db.js';
import { tradingAccountTargetIds } from './trading_account_targets.js';
import { updateTradingRuntimeState } from './trading_repository.js';
import { TradingEngine } from './trading_engine.js';
import { ClockGuard, type ClockHealthMonitor } from './clock_guard.js';
import type { StartupAuthority } from './startup_authority.js';
import {
  listActiveExchangeStreamSymbols,
  markExchangeStreamsStopped,
  persistExchangeStreamBatch,
  recordExchangeStreamFailure,
} from './exchange_stream_repository.js';

type RuntimeLogger = (message: string) => void;
interface PendingEntryCursor { id: string; created_at: number }

export class TradingRuntime {
  private timer: NodeJS.Timeout | null = null;
  private streamTimer: NodeJS.Timeout | null = null;
  private active: Promise<void> | null = null;
  private streamActive: Promise<void> | null = null;
  private stopped = true;
  private entriesEnabled = false;
  private releaseEntryPause: (() => void) | null = null;
  private protectionScanComplete = false;
  private readonly streamCursors = new Map<string, number>();
  private readonly streamDirtyAccounts = new Set<string>();
  private readonly streamFailureLogState = new Map<string, { message: string; loggedAt: number }>();
  private reconciliationFailureLog: { summary: string; loggedAt: number; suppressed: number } | null = null;
  private pendingEntryCursor: PendingEntryCursor | null = null;

  constructor(
    private readonly engine: TradingEngine,
    private readonly intervalMs = 2_000,
    private readonly logger: RuntimeLogger = () => undefined,
    private readonly clockGuard: ClockHealthMonitor = new ClockGuard(),
    private readonly startup?: Pick<StartupAuthority, 'canEnter' | 'assertEntryReady'>,
  ) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 250 || intervalMs > 60_000) {
      throw new Error('Trading runtime interval must be between 250 and 60000 milliseconds.');
    }
  }

  async start(options: { allowEntries?: boolean } = {}): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.disableEntries();
    this.protectionScanComplete = false;
    try {
      await this.runOnce(true);
      if (options.allowEntries === true) await this.enableEntries();
    } catch (error) {
      this.logger(
        `[TRADING] Startup reconciliation failed; trading remains fail-closed and will retry: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.timer = setInterval(() => this.wake(), this.intervalMs);
    this.timer.unref();
    const streamIntervalMs = Math.max(250, Math.min(1_000, Math.floor(this.intervalMs / 2)));
    this.streamTimer = setInterval(() => this.wakeStreams(), streamIntervalMs);
    this.streamTimer.unref();
    this.wakeStreams();
  }

  async startProtectionOnly(): Promise<void> {
    await this.start({ allowEntries: false });
  }

  async enableEntries(): Promise<void> {
    if (this.stopped) throw new Error('Trading runtime is not running.');
    this.startup?.assertEntryReady();
    if (!this.protectionScanComplete) throw new Error('Trading protection scan has not completed; individual account readiness remains required.');
    await this.assertEntryClockHealthy();
    const state = await getDatabase().get<{
      execution_enabled: number;
      kill_switch_active: number;
    }>('SELECT execution_enabled, kill_switch_active FROM trading_runtime_state WHERE singleton_id = 1');
    if (state?.execution_enabled !== 1 || state.kill_switch_active === 1) {
      throw new Error('Trading entries cannot be enabled while execution is disabled or the kill switch is active.');
    }
    this.startup?.assertEntryReady();
    this.entriesEnabled = true;
    this.releaseEntryPause?.();
    this.releaseEntryPause = null;
  }

  disableEntries(): void {
    this.engine.mutations.fenceEntries();
    this.releaseEntryPause ??= this.engine.mutations.holdEntries();
    this.entriesEnabled = false;
  }

  private async assertEntryClockHealthy(): Promise<void> {
    const clock = this.clockGuard.sample();
    if (clock.healthy) return;
    this.disableEntries();
    await updateTradingRuntimeState({
      executionEnabled: false,
      killSwitchActive: true,
      killSwitchReason: 'System clock drift exceeded the trading safety limit',
    });
    throw new Error(clock.reason || 'System clock drift is unsafe; trading entries are disabled.');
  }

  /** Completion of the scan is not proof that every account is healthy. */
  isProtectionScanComplete(): boolean {
    return this.protectionScanComplete;
  }

  wake(): void {
    if (this.stopped || this.active !== null) return;
    this.active = this.runOnce(false)
      .catch(error => this.logger(`[TRADING] Runtime cycle failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => { this.active = null; });
  }

  async stop(): Promise<void> {
    this.disableEntries();
    this.stopped = true;
    this.entriesEnabled = false;
    this.protectionScanComplete = false;
    if (this.timer) clearInterval(this.timer);
    if (this.streamTimer) clearInterval(this.streamTimer);
    this.timer = null;
    this.streamTimer = null;
    await this.active;
    await this.streamActive;
    this.streamCursors.clear();
    this.streamDirtyAccounts.clear();
    this.streamFailureLogState.clear();
    this.reconciliationFailureLog = null;
    this.pendingEntryCursor = null;
    await markExchangeStreamsStopped();
  }

  private async runOnce(startup: boolean): Promise<void> {
    const failures = await this.reconcileAccounts(startup);
    await this.captureEntryExpiryFailure(failures);
    if (failures.length > 0) {
      const summary = `${failures.length} account protection reconciliation task(s) failed; affected entries remain fail-closed: ${failures.join('; ')}`;
      const now = Date.now();
      const repeated = this.reconciliationFailureLog?.summary === summary;
      if (!repeated || !this.reconciliationFailureLog || now - this.reconciliationFailureLog.loggedAt >= 60_000) {
        const suffix = repeated && this.reconciliationFailureLog.suppressed > 0
          ? ` (${this.reconciliationFailureLog.suppressed} identical retries suppressed)`
          : '';
        this.logger(`[TRADING] ${summary}${suffix}`);
        this.reconciliationFailureLog = { summary, loggedAt: now, suppressed: 0 };
      } else {
        this.reconciliationFailureLog.suppressed += 1;
      }
    } else {
      this.reconciliationFailureLog = null;
    }
    this.protectionScanComplete = true;
    if (this.startup && !this.startup.canEnter()) this.disableEntries();
    if (this.entriesEnabled) {
      await this.assertEntryClockHealthy();
      await this.processPendingEntries();
    }
  }

  private async reconcileAccounts(startup: boolean): Promise<string[]> {
    const accountIds = await tradingAccountTargetIds();
    const failures: string[] = [];
    for (const accountId of accountIds) {
      try {
        await this.engine.retireUnauthorizedPreparations(accountId);
      } catch (error: any) {
        failures.push(`${accountId} preparation-recovery: ${error?.message || String(error)}`);
      }
      try {
        const streamTriggered = this.streamDirtyAccounts.delete(accountId);
        await this.engine.reconcileAccount(accountId, {
          force: startup || streamTriggered,
        });
      } catch (error: any) {
        const message = error?.message || String(error);
        failures.push(`${accountId}: ${message}`);
      }
    }
    return failures;
  }

  private wakeStreams(): void {
    if (this.stopped || this.streamActive !== null) return;
    this.streamActive = this.pollExchangeStreams()
      .catch(error => this.logger(
        `[TRADING] Exchange WebSocket polling failed without bypassing REST protection: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ))
      .finally(() => { this.streamActive = null; });
  }

  private async pollExchangeStreams(): Promise<void> {
    const accounts = await getDatabase().all<Array<{ id: string }>>(
      `SELECT id FROM trading_accounts
       WHERE enabled = 1 AND status = 'ready' AND exchange <> 'paper'
       ORDER BY created_at`,
    );
    let requiresWake = false;
    for (const account of accounts) {
      try {
        const symbols = await listActiveExchangeStreamSymbols(account.id);
        const result = await this.engine.pollAccountStream(
          account.id,
          this.streamCursors.get(account.id) ?? 0,
          symbols,
        );
        if (!result) continue;
        const persisted = await persistExchangeStreamBatch(result.account, result.batch);
        this.streamFailureLogState.delete(account.id);
        this.streamCursors.set(account.id, result.batch.nextCursor);
        if (persisted.stateChanges > 0 || persisted.gap) {
          this.streamDirtyAccounts.add(account.id);
          requiresWake = true;
        }
      } catch (error) {
        await recordExchangeStreamFailure(account.id, error);
        const message = error instanceof Error ? error.message : String(error);
        const previous = this.streamFailureLogState.get(account.id);
        if (previous?.message !== message || Date.now() - (previous?.loggedAt ?? 0) >= 30_000) {
          this.logger(
            `[TRADING] Exchange WebSocket degraded for ${account.id}; REST reconciliation remains authoritative: ${message}`,
          );
          this.streamFailureLogState.set(account.id, { message, loggedAt: Date.now() });
        }
      }
    }
    if (requiresWake) this.wake();
  }

  private async captureEntryExpiryFailure(failures: string[]): Promise<void> {
    try {
      await this.engine.cancelExpiredEntries();
    } catch (error: any) {
      failures.push(`entry-expiry: ${error?.message || String(error)}`);
    }
  }

  private async processPendingEntries(): Promise<void> {
    const state = await getDatabase().get<{ execution_enabled: number; kill_switch_active: number }>(
      'SELECT execution_enabled, kill_switch_active FROM trading_runtime_state WHERE singleton_id = 1',
    );
    if (state?.execution_enabled !== 1 || state.kill_switch_active === 1) {
      this.entriesEnabled = false;
      return;
    }
    const intents = await this.pendingEntryBatch();
    for (const intent of intents) {
      if (!this.entriesEnabled) break;
      // Advance only to an attempted row, including a missing/failed one. A pause cannot skip the rest of this page.
      this.pendingEntryCursor = intent;
      await this.engine.processIntent(intent.id);
    }
  }

  /** Scheduling only: restart revisits durable rows; no cursor can certify or terminalize an order. */
  private async pendingEntryBatch(): Promise<PendingEntryCursor[]> {
    const cursor = this.pendingEntryCursor;
    const rows = await getDatabase().all<PendingEntryCursor[]>(
      `SELECT id, created_at FROM trading_trade_intents WHERE status IN ('pending', 'planned', 'submitting')
       AND (? IS NULL OR created_at > ? OR (created_at = ? AND id > ?)) ORDER BY created_at, id LIMIT 100`,
      [cursor?.created_at ?? null, cursor?.created_at ?? null, cursor?.created_at ?? null, cursor?.id ?? null],
    );
    if (rows.length === 0 && cursor) {
      this.pendingEntryCursor = null;
      return this.pendingEntryBatch();
    }
    return rows;
  }
}
