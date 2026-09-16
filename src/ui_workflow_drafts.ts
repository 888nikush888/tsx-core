import { getDatabase, withDatabaseTransaction } from './db.js';
import { validateGraph, saveWorkflowRevision } from './workflow_repository.js';
import { reviewHash } from './ui_change_review.js';

const LIFETIME_MS = 30 * 86_400_000;
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(value)) throw new Error('Invalid graph draft identifier.');
  return value;
}
export async function getUiWorkflowDraft(id: string) {
  identifier(id);
  const row = await getDatabase().get('SELECT * FROM workflow_graph_drafts WHERE id = ?', [id]);
  return row ? { id: row.id, version: row.version, baseRevisionId: row.base_revision_id, graph: JSON.parse(row.graph_json),
    createdBy: row.created_by, updatedBy: row.updated_by, createdAt: row.created_at, updatedAt: row.updated_at, expiresAt: row.expires_at, expired: row.expires_at <= Date.now() } : null;
}

function assertDraftIdentity(id: string): void {
  identifier(id);
}

function assertDraftBaseVersion(baseVersion: number | null): void {
  if (baseVersion !== null && (!Number.isSafeInteger(baseVersion) || baseVersion < 1)) throw new Error('A graph draft base version is required.');
}

function assertDraftActor(actorId: string): void {
  if (!actorId || actorId.length > 128 || /[\r\n\0]/.test(actorId)) throw new Error('Invalid draft actor.');
}

function assertDraftBaseRevision(baseRevisionId: string | null): void {
  if (baseRevisionId !== null && typeof baseRevisionId !== 'string') throw new Error('A graph base revision is required.');
}

function assertSaveDraftInput(input: { id: string; baseVersion: number | null; baseRevisionId: string | null; graph: unknown }, actorId: string): void {
  assertDraftIdentity(input.id);
  assertDraftBaseVersion(input.baseVersion);
  assertDraftActor(actorId);
  assertDraftBaseRevision(input.baseRevisionId);
}

function serializeDraftGraph(graph: unknown): string {
  const serialized = JSON.stringify(validateGraph(graph));
  if (Buffer.byteLength(serialized) > 1_048_576) throw new Error('Graph draft exceeds 1 MiB.');
  return serialized;
}
export function saveUiWorkflowDraft(input: { id: string; baseVersion: number | null; baseRevisionId: string | null; graph: unknown }, actorId: string) {
  assertSaveDraftInput(input, actorId);
  const serialized = serializeDraftGraph(input.graph);
  return withDatabaseTransaction(async () => {
    const current = await getUiWorkflowDraft(input.id);
    if ((current?.version ?? null) !== input.baseVersion) throw new Error('GRAPH_DRAFT_VERSION_CONFLICT');
    if (!current && Number((await getDatabase().get('SELECT COUNT(*) AS count FROM workflow_graph_drafts')).count) >= 20) throw new Error('Graph draft capacity reached. Remove an unused draft.');
    const now = Date.now();
    await getDatabase().run(`INSERT INTO workflow_graph_drafts (id, version, base_revision_id, graph_json, created_by, updated_by, created_at, updated_at, expires_at)
      VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET version = workflow_graph_drafts.version + 1,
      base_revision_id = excluded.base_revision_id, graph_json = excluded.graph_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at, expires_at = excluded.expires_at`,
    [input.id, input.baseRevisionId, serialized, actorId, actorId, now, now, now + LIFETIME_MS]);
    return getUiWorkflowDraft(input.id);
  });
}

export async function deleteUiWorkflowDraft(id: string, baseVersion: unknown) {
  identifier(id);
  if (!Number.isSafeInteger(baseVersion)) throw new Error('Draft version required for deletion.');
  const result = await getDatabase().run('DELETE FROM workflow_graph_drafts WHERE id = ? AND version = ?', [id, baseVersion]);
  if (result.changes !== 1) throw new Error('GRAPH_DRAFT_VERSION_CONFLICT');
  return { id, deleted: true };
}

function assertDraftAlive(
  current: Awaited<ReturnType<typeof getUiWorkflowDraft>>,
): asserts current is NonNullable<Awaited<ReturnType<typeof getUiWorkflowDraft>>> {
  if (!current || current.expired) throw new Error('GRAPH_DRAFT_VERSION_CONFLICT');
}

function assertDraftVersion(
  current: NonNullable<Awaited<ReturnType<typeof getUiWorkflowDraft>>>,
  binding: { id: string; version: number },
): void {
  if (current.version !== binding.version) throw new Error('GRAPH_DRAFT_VERSION_CONFLICT');
}

function assertDraftBase(
  current: NonNullable<Awaited<ReturnType<typeof getUiWorkflowDraft>>>,
  input: Parameters<typeof saveWorkflowRevision>[0],
): void {
  if (current.baseRevisionId !== input.baseRevisionId) throw new Error('GRAPH_DRAFT_VERSION_CONFLICT');
}

function assertDraftGraph(
  current: NonNullable<Awaited<ReturnType<typeof getUiWorkflowDraft>>>,
  input: Parameters<typeof saveWorkflowRevision>[0],
): void {
  if (reviewHash(current.graph) !== reviewHash(validateGraph(input.graph))) throw new Error('GRAPH_DRAFT_VERSION_CONFLICT');
}

function assertDraftBinding(
  current: Awaited<ReturnType<typeof getUiWorkflowDraft>>,
  binding: { id: string; version: number },
  input: Parameters<typeof saveWorkflowRevision>[0],
): asserts current is NonNullable<Awaited<ReturnType<typeof getUiWorkflowDraft>>> {
  assertDraftAlive(current);
  assertDraftVersion(current, binding);
  assertDraftBase(current, input);
  assertDraftGraph(current, input);
}

/** Draft identity, graph, active revision and the new draft base commit under the same database owner. */
export function activateUiWorkflowDraft(input: Parameters<typeof saveWorkflowRevision>[0], binding: { id: string; version: number }) {
  return withDatabaseTransaction(async () => {
    const current = await getUiWorkflowDraft(binding.id);
    assertDraftBinding(current, binding, input);
    const workflow = await saveWorkflowRevision(input);
    const draft = await saveUiWorkflowDraft({ id: current.id, baseVersion: current.version, baseRevisionId: workflow.id, graph: workflow.graph }, input.actorId);
    return { workflow, draft };
  });
}
