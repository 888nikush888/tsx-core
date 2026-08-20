import { getDatabase } from './db.js';
import { updateTradingRuntimeState } from './trading_repository.js';
import { TradingEngine } from './trading_engine.js';
import { ClockGuard, type ClockHealthMonitor } from './clock_guard.js';
import {
  listActiveExchangeStreamSymbols,
  markExchangeStreamsStopped,
  persistExchangeStreamBatch,
  recordExchangeStreamFailure,
} from './exchange_stream_repository.js';

type RuntimeLogger = (message: string) => void;

export class TradingRuntime {
  private timer: NodeJS.Timeout | null = null;
  private streamTimer: NodeJS.Timeout | null = null;
  private active: Promise<void> | null = null;
  private streamActive: Promise<void> | null = null;
  private stopped = true;
  private entriesEnabled = false;
  private protectionHealthy = false;
  private readonly streamCursors = new Map<string, number>();
  private readonly streamDirtyAccounts = new Set<string>();
  private readonly streamFailureLogState = new Map<string, { message: string; loggedAt: number }>();

  constructor(
    private readonly engine: TradingEngine,
    private readonly intervalMs = 2_000,
    private readonly logger: RuntimeLogger = () => undefined,
    private readonly clockGuard: ClockHealthMonitor = new ClockGuard(),
  ) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 250 || intervalMs > 60_000) {
      throw new Error('Trading runtime interval must be between 250 and 60000 milliseconds.');
    }
  }

  async start(options: { allowEntries?: boolean } = {}): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.entriesEnabled = false;
    this.protectionHealthy = false;
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
    if (!this.protectionHealthy) throw new Error('Trading protection has not reached a healthy reconciliation latch.');
    await this.assertEntryClockHealthy();
    const state = await getDatabase().get<{
      execution_enabled: number;
      kill_switch_active: number;
    }>('SELECT execution_enabled, kill_switch_active FROM trading_runtime_state WHERE singleton_id = 1');
    if (state?.execution_enabled !== 1 || state.kill_switch_active === 1) {
      throw new Error('Trading entries cannot be enabled while execution is disabled or the kill switch is active.');
    }
    this.entriesEnabled = true;
  }

  disableEntries(): void {
    this.entriesEnabled = false;
  }

  private async assertEntryClockHealthy(): Promise<void> {
    const clock = this.clockGuard.sample();
    if (clock.healthy) return;
    this.entriesEnabled = false;
    await updateTradingRuntimeState({
      executionEnabled: false,
      killSwitchActive: true,
      killSwitchReason: 'System clock drift exceeded the trading safety limit',
    });
    throw new Error(clock.reason || 'System clock drift is unsafe; trading entries are disabled.');
  }

  isProtectionHealthy(): boolean {
    return this.protectionHealthy;
  }

  wake(): void {
    if (this.stopped || this.active !== null) return;
    this.active = this.runOnce(false)
      .catch(error => this.logger(`[TRADING] Runtime cycle failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => { this.active = null; });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.entriesEnabled = false;
    this.protectionHealthy = false;
    if (this.timer) clearInterval(this.timer);
    if (this.streamTimer) clearInterval(this.streamTimer);
    this.timer = null;
    this.streamTimer = null;
    await this.active;
    await this.streamActive;
    this.streamCursors.clear();
    this.streamDirtyAccounts.clear();
    this.streamFailureLogState.clear();
    await markExchangeStreamsStopped();
  }

  private async runOnce(startup: boolean): Promise<void> {
    const failures = await this.reconcileAccounts(startup);
    await this.captureEntryExpiryFailure(failures);
    if (failures.length > 0) await this.failProtectionCycle(startup, failures);
    this.protectionHealthy = true;
    if (this.entriesEnabled) {
      await this.assertEntryClockHealthy();
      await this.processPendingEntries();
    }
  }

  private async reconcileAccounts(startup: boolean): Promise<string[]> {
    const accounts = await getDatabase().all<Array<{ id: string }>>(
      `SELECT id FROM trading_accounts WHERE enabled = 1 AND status = 'ready' ORDER BY created_at`,
    );
    const failures: string[] = [];
    for (const account of accounts) {
      try {
        const streamTriggered = this.streamDirtyAccounts.delete(account.id);
        await this.engine.reconcileAccount(account.id, { force: startup || streamTriggered });
      } catch (error: any) {
        failures.push(`${account.id}: ${error?.message || String(error)}`);
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

  private async failProtectionCycle(startup: boolean, failures: string[]): Promise<never> {
    this.entriesEnabled = false;
    this.protectionHealthy = false;
    const cycle = startup ? 'Startup' : 'Periodic';
    await updateTradingRuntimeState({
      executionEnabled: false,
      killSwitchActive: true,
      killSwitchReason: `${cycle} reconciliation failed for ${failures.length} protection task(s)`,
    });
    throw new Error(`${cycle} trading protection failed: ${failures.join('; ')}`);
  }

  private async processPendingEntries(): Promise<void> {
    const state = await getDatabase().get<{ execution_enabled: number; kill_switch_active: number }>(
      'SELECT execution_enabled, kill_switch_active FROM trading_runtime_state WHERE singleton_id = 1',
    );
    if (state?.execution_enabled !== 1 || state.kill_switch_active === 1) {
      this.entriesEnabled = false;
      return;
    }
    const intents = await getDatabase().all<Array<{ id: string }>>(
      `SELECT id FROM trading_trade_intents WHERE status = 'pending' ORDER BY created_at LIMIT 100`,
    );
    for (const intent of intents) await this.engine.processIntent(intent.id);
  }
}
