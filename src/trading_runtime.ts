import { getDatabase } from './db.js';
import { updateTradingRuntimeState } from './trading_repository.js';
import { TradingEngine } from './trading_engine.js';

type RuntimeLogger = (message: string) => void;

export class TradingRuntime {
  private timer: NodeJS.Timeout | null = null;
  private active: Promise<void> | null = null;
  private stopped = true;

  constructor(
    private readonly engine: TradingEngine,
    private readonly intervalMs = 2_000,
    private readonly logger: RuntimeLogger = () => undefined,
  ) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 250 || intervalMs > 60_000) {
      throw new Error('Trading runtime interval must be between 250 and 60000 milliseconds.');
    }
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    await this.runOnce(true);
    this.timer = setInterval(() => this.wake(), this.intervalMs);
    this.timer.unref();
  }

  wake(): void {
    if (this.stopped || this.active) return;
    this.active = this.runOnce(false)
      .catch(error => this.logger(`[TRADING] Runtime cycle failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => { this.active = null; });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.active;
  }

  private async runOnce(startup: boolean): Promise<void> {
    const accounts = await getDatabase().all<Array<{ id: string }>>(
      `SELECT id FROM trading_accounts WHERE enabled = 1 AND status = 'ready' ORDER BY created_at`,
    );
    for (const account of accounts) {
      try {
        await this.engine.reconcileAccount(account.id);
      } catch (error: any) {
        await updateTradingRuntimeState({
          executionEnabled: false,
          killSwitchActive: true,
          killSwitchReason: `${startup ? 'Startup' : 'Periodic'} reconciliation failed for account ${account.id}`,
        });
        throw error;
      }
    }
    await this.engine.cancelExpiredEntries();
    const intents = await getDatabase().all<Array<{ id: string }>>(
      `SELECT id FROM trading_trade_intents WHERE status = 'pending' ORDER BY created_at LIMIT 100`,
    );
    for (const intent of intents) await this.engine.processIntent(intent.id);
  }
}
