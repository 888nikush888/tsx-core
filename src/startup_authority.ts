import { once } from 'node:events';
import type { Server } from 'node:http';

/** Application startup authorization is separate from persisted trading preferences. */
export const STARTUP_GATES = [
  'configuration', 'crash', 'database', 'protection_scan', 'retention', 'dashboard', 'monitoring', 'backup',
] as const;
export type StartupGate = typeof STARTUP_GATES[number] | 'routing';
export type StartupPhase = 'initial' | 'recovery-only' | 'ready' | 'blocked';

export class StartupAuthorityError extends Error {
  readonly code = 'STARTUP_NOT_READY';
  constructor(phase: StartupPhase, reason: string | null) {
    super(`Startup authority is ${phase}; mutations are blocked${reason ? `: ${reason}` : '.'}`);
    this.name = 'StartupAuthorityError';
  }
}

/** A failed startup cannot be resurrected by a late successful asynchronous gate. */
export class StartupAuthority {
  private phase: StartupPhase = 'initial';
  private reason: string | null = null;
  private generation = 0;
  private recoveryAuthorized = false;
  private readonly completed = new Set<StartupGate>();
  private readonly holds = new Map<symbol, string>();

  beginRecovery(): void {
    if (this.phase !== 'initial') throw new StartupAuthorityError(this.phase, 'A fresh startup is required.');
    this.phase = 'recovery-only';
    this.recoveryAuthorized = true;
    this.generation += 1;
  }

  completeGate(gate: StartupGate): void {
    assertKnownGate(gate);
    // An empty Telegram setup must remain editable once the control plane is healthy.
    // It cannot admit entries until routing has completed its own startup gate.
    if (this.phase !== 'recovery-only' && !(this.phase === 'ready' && gate === 'routing')) {
      throw new StartupAuthorityError(this.phase, this.reason);
    }
    this.completed.add(gate);
  }

  failGate(gate: StartupGate, reason: string): void {
    assertKnownGate(gate);
    this.block(`${gate}: ${reason}`);
  }

  release(): void {
    if (this.phase !== 'recovery-only') throw new StartupAuthorityError(this.phase, this.reason);
    const missing = STARTUP_GATES.filter(gate => !this.completed.has(gate));
    if (missing.length) throw new Error(`Startup gates remain incomplete: ${missing.join(', ')}.`);
    this.phase = 'ready';
    this.generation += 1;
  }

  block(reason: string): void {
    if (!reason.trim()) throw new Error('Startup revocation requires a reason.');
    if (this.phase === 'blocked') return;
    this.phase = 'blocked';
    this.reason = reason;
    this.generation += 1;
  }

  /** Only the returned capability may release this hold; failed startup remains sticky. */
  holdMutations(reason: string): () => void {
    if (!reason.trim()) throw new Error('A maintenance hold requires a reason.');
    const token = Symbol(reason);
    this.holds.set(token, reason);
    this.generation += 1;
    return () => {
      if (this.holds.delete(token)) this.generation += 1;
    };
  }

  canMutate(): boolean { return this.phase === 'ready' && this.holds.size === 0; }
  canEnter(): boolean { return this.canMutate() && this.completed.has('routing'); }
  canProtect(): boolean { return this.recoveryAuthorized; }

  assertReady(): void {
    if (!this.canMutate()) throw new StartupAuthorityError(this.phase, this.reason ?? [...this.holds.values()][0] ?? null);
  }

  assertEntryReady(): void {
    this.assertReady();
    if (!this.canEnter()) throw new StartupAuthorityError(this.phase, 'Routing startup gate is incomplete.');
  }

  snapshot() {
    return { phase: this.phase, reason: this.reason, generation: this.generation,
      completedGates: STARTUP_GATES.filter(gate => this.completed.has(gate)),
      mutationHolds: [...this.holds.values()],
      routingReady: this.completed.has('routing'),
      pendingGates: STARTUP_GATES.filter(gate => !this.completed.has(gate)) };
  }
}

/** Gate failure is permanent for this process; later infrastructure success cannot release it. */
export async function runStartupGate<T>(authority: StartupAuthority, gate: StartupGate, action: () => Promise<T>): Promise<T> {
  try {
    const result = await action();
    if (authority.snapshot().phase !== 'blocked') authority.completeGate(gate);
    return result;
  } catch (error) {
    authority.failGate(gate, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

function assertKnownGate(gate: StartupGate): void {
  if (gate !== 'routing' && !(STARTUP_GATES as readonly string[]).includes(gate)) throw new Error('Unknown startup gate.');
}

/** Binding a port is asynchronous: constructing a server is not a passed startup gate. */
export async function waitForStartupListener(server: Server): Promise<void> {
  if (server.listening) return;
  await once(server, 'listening', { signal: AbortSignal.timeout(5_000) });
}
