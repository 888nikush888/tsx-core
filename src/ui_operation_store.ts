import { unknownErrorMessage } from './contract_values.js';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { maskPII } from './logger.js';
import { decodeUiCursor, encodeUiCursor, filterFingerprint } from './ui_cursor.js';

export const UI_PROCESS_INSTANCE_ID = randomUUID();
export type UiJobKind = 'backup-drill' | 'parser-test' | 'backup-create' | 'backup-restore' | 'backup-recover' | 'restart' | 'factory-reset';
export type UiJobState = 'accepted' | 'running' | 'awaiting-restart' | 'succeeded' | 'failed' | 'unknown';
export interface UiJob {
  version: 1; id: string; kind: UiJobKind; actorId: string; scope: Record<string, unknown>; requestHash: string;
  state: UiJobState; stage: string; acceptedAt: number; updatedAt: number; instanceId: string;
  result: unknown; error: string | null;
  restart?: { sourceInstanceId: string; confirmedAt: number; receipt: 'durable' | 'uncertain'; observedInstanceId?: string };
}
const ID = /^[a-zA-Z0-9_-]{16,64}$/;
const MAX_RECORD_BYTES = 65_536;
const MAX_RECORDS = 200;
const terminal = (state: UiJobState) => ['succeeded', 'failed', 'unknown'].includes(state);

/** Separate from the trading DB: a restore cannot roll back its own progress record. */
export class UiOperationStore {
  private readonly root: string;
  private readonly records = new Map<string, UiJob>();
  private initialized: Promise<void> | null = null;
  private writes: Promise<unknown> = Promise.resolve();
  constructor(directory: string, private readonly instanceId = UI_PROCESS_INSTANCE_ID) { this.root = path.resolve(directory); }
  get processInstanceId(): string { return this.instanceId; }

  private ready(): Promise<void> {
    this.initialized ??= this.initialize();
    return this.initialized;
  }
  private async initialize(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const rootStat = await fs.lstat(this.root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Operator job directory is not a regular private directory.');
    const names = (await fs.readdir(this.root)).filter(name => name.endsWith('.json'));
    if (names.length > MAX_RECORDS) throw new Error('Operator job store exceeds its record limit.');
    for (const name of names) {
      const id = name.slice(0, -5); const record = await this.readRecord(id);
      this.records.set(id, record);
      if (record.instanceId !== this.instanceId && (!terminal(record.state) || record.restart?.receipt === 'uncertain')) await this.observeInterruptedRecord(record);
    }
  }
  private async readRecord(id: string): Promise<UiJob> {
      const filename = this.filename(id);
      const stat = await fs.lstat(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RECORD_BYTES) throw new Error('Operator job record is not a bounded regular file.');
      const record = JSON.parse(await fs.readFile(filename, 'utf8')) as UiJob;
      if (record.version !== 1 || record.id !== id || !Number.isSafeInteger(record.updatedAt)
        || !['accepted', 'running', 'awaiting-restart', 'succeeded', 'failed', 'unknown'].includes(record.state)) throw new Error('Invalid operator job record.');
      return record;
  }
  private async observeInterruptedRecord(record: UiJob): Promise<void> {
        const restarted = record.state === 'awaiting-restart' && record.restart?.receipt !== 'uncertain';
        const next: UiJob = { ...record, state: restarted ? 'succeeded' : 'unknown', updatedAt: Date.now(),
          stage: restarted ? 'New process instance observed; readiness and trading gates remain separate.' : 'Process ended before a conclusive result; no automatic replay.',
          result: restarted ? { previous: record.result, observedInstanceId: this.instanceId } : record.result,
          ...(record.restart ? { restart: { ...record.restart, observedInstanceId: this.instanceId } } : {}) };
        await this.persist(next);
  }
  private filename(id: string): string {
    if (!ID.test(id)) throw new Error('Invalid operator job ID.');
    const filename = path.resolve(this.root, `${id}.json`);
    if (path.dirname(filename) !== this.root) throw new Error('Operator job path escaped its store.');
    return filename;
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.writes.then(operation);
    this.writes = pending.catch(() => undefined);
    return pending;
  }
  private async persist(record: UiJob): Promise<void> {
    const serialized = JSON.stringify(record);
    if (Buffer.byteLength(serialized) > MAX_RECORD_BYTES) throw new Error('Operator job result exceeds its storage limit.');
    const destination = this.filename(record.id);
    const temporary = path.join(this.root, `${record.id}.${randomUUID()}.tmp`);
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(serialized, 'utf8'); await handle.sync(); await handle.close(); handle = undefined;
      await fs.rename(temporary, destination);
      const directory = await fs.open(this.root, 'r');
      try { await directory.sync(); }
      catch (error: any) { if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM'].includes(error?.code)) throw error; }
      finally { await directory.close(); }
      this.records.set(record.id, structuredClone(record));
    } finally { await handle?.close(); await fs.unlink(temporary).catch(() => undefined); }
  }
  async get(id: string): Promise<UiJob | null> { this.filename(id); await this.ready(); return structuredClone(this.records.get(id) ?? null); }
  async list(): Promise<UiJob[]> { await this.ready(); return [...this.records.values()].sort((a, b) => b.acceptedAt - a.acceptedAt || compareJobIdsDescending(a.id, b.id)).map(record => structuredClone(record)); }

  async page(params: URLSearchParams) {
    const state = params.get('state') || ''; const kind = params.get('kind') || '';
    if (state && !['accepted', 'running', 'awaiting-restart', 'succeeded', 'failed', 'unknown'].includes(state)) throw new Error('Invalid job state.');
    if (kind && !['backup-drill', 'parser-test', 'backup-create', 'backup-restore', 'backup-recover', 'restart', 'factory-reset'].includes(kind)) throw new Error('Invalid job kind.');
    const limit = Number(params.get('limit') || 50);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Job page limit must be 1–100.');
    const filter = filterFingerprint({ kind, state }); const cursor = decodeUiCursor(params.get('cursor'), filter);
    const observedAt = cursor?.observedAt ?? Date.now();
    const selection = (await this.list()).filter(job => (!kind || job.kind === kind) && (!state || job.state === state)
      && job.acceptedAt <= observedAt && (!cursor || job.acceptedAt < cursor.createdAt || (job.acceptedAt === cursor.createdAt && job.id < cursor.id)));
    const jobs = selection.slice(0, limit); const last = jobs.at(-1); const hasMore = selection.length > limit;
    return { jobs, hasMore, nextCursor: hasMore && last ? encodeUiCursor({ version: 1, filter, observedAt, createdAt: last.acceptedAt, id: last.id }) : null,
      observedAt, statesObservedAt: Date.now(), retention: 'Last 200 jobs; active jobs are retained. State filters use current observations.' };
  }

  async accept(input: { id: string; kind: UiJobKind; actorId: string; scope: Record<string, unknown>; request: unknown }): Promise<{ job: UiJob; created: boolean }> {
    this.filename(input.id); await this.ready();
    if (!input.actorId || input.actorId.length > 128) throw new Error('Invalid operator actor.');
    const requestHash = createHash('sha256').update(JSON.stringify(input.request)).digest('hex');
    return this.serial(async () => {
      const existing = this.records.get(input.id);
      if (existing) {
        if (existing.actorId !== input.actorId || existing.kind !== input.kind || existing.requestHash !== requestHash) throw new Error('Operator job key is already bound to another request.');
        return { job: structuredClone(existing), created: false };
      }
      if ([...this.records.values()].filter(record => !terminal(record.state)).length >= 2) throw new Error('Two operator jobs are already active.');
      if (this.records.size >= MAX_RECORDS) {
        const oldest = [...this.records.values()].filter(record => terminal(record.state)).sort((a, b) => a.acceptedAt - b.acceptedAt)[0];
        if (!oldest) throw new Error('Operator job store is full.');
        await fs.unlink(this.filename(oldest.id)); this.records.delete(oldest.id);
      }
      const now = Date.now();
      const job: UiJob = { version: 1, id: input.id, kind: input.kind, actorId: input.actorId, scope: input.scope, requestHash,
        state: 'accepted', stage: 'Request durably accepted.', acceptedAt: now, updatedAt: now, instanceId: this.instanceId, result: null, error: null };
      await this.persist(job); return { job: structuredClone(job), created: true };
    });
  }
  async update(id: string, change: Pick<UiJob, 'state' | 'stage'> & Partial<Pick<UiJob, 'result' | 'error'>>): Promise<UiJob> {
    await this.ready();
    return this.serial(async () => {
      const existing = this.records.get(id);
      if (!existing) throw new Error('Operator job not found.');
      const next = { ...existing, ...change, updatedAt: Date.now() };
      await this.persist(next); return structuredClone(next);
    });
  }
  async run(id: string, operation: () => Promise<unknown>, restart = false): Promise<void> {
    try {
      await this.update(id, { state: 'running', stage: 'Command is running.' });
      const result = await operation();
      await this.update(id, { state: restart ? 'awaiting-restart' : 'succeeded', stage: restart ? 'Command confirmed; waiting for a new process instance.' : 'Command completed with the recorded result.', result });
    } catch (error) {
      await this.update(id, { state: 'failed', stage: 'Command did not complete successfully. Confirmed partial effects must be reviewed.', error: maskPII(unknownErrorMessage(error)).slice(0, 2000) });
    }
  }

  /** Only a successfully returned command authorizes its restart; receipt I/O is a separate outcome. */
  async runRestart(id: string, operation: () => Promise<unknown>): Promise<UiJob> {
    await this.update(id, { state: 'running', stage: 'Checking maintenance and safety gates; command is running.' });
    let result: unknown;
    try { result = await operation(); }
    catch (error) {
      await this.recordUnsuccessfulCommand(id, error);
      throw error;
    }
    return this.serial(async () => {
      const existing = this.records.get(id);
      if (!existing) throw new Error('UI operation record is missing.');
      const next: UiJob = { ...existing, state: 'awaiting-restart', updatedAt: Date.now(), result, error: null,
        stage: 'Command confirmed; restart requested for this process generation. Readiness and trading gates remain separate.',
        restart: { sourceInstanceId: this.instanceId, confirmedAt: Date.now(), receipt: 'durable' } };
      try { await this.persist(next); }
      catch {
        next.state = 'unknown';
        next.stage = 'Command returned successfully; its durable completion receipt is uncertain. Restart remains required; do not repeat the command.';
        next.error = 'Completion receipt could not be durably confirmed.';
        if (next.restart) next.restart.receipt = 'uncertain';
        // A second write may recover a transient fault. Even if it fails, retain the honest
        // in-process outcome and restart intent; the previous running record prevents replay after a crash.
        await this.persist(next).catch(() => undefined);
        this.records.set(id, structuredClone(next));
      }
      return structuredClone(next);
    });
  }

  private async recordUnsuccessfulCommand(id: string, error: unknown): Promise<void> {
    try {
      await this.update(id, { state: 'failed', stage: 'Command did not return a confirmed result. Inspect partial effects; no automatic replay.',
        error: maskPII(unknownErrorMessage(error)).slice(0, 2000) });
    } catch {
      const existing = this.records.get(id);
      if (!existing) throw new Error('UI operation record is missing.');
      this.records.set(id, { ...existing, state: 'unknown', stage: 'Command and failure receipt are uncertain; no automatic replay.', updatedAt: Date.now() });
    }
  }
}

function compareJobIdsDescending(left: string, right: string): number {
  if (left < right) return 1;
  return left > right ? -1 : 0;
}
