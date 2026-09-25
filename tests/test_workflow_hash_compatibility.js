import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb } from '../src/db.js';
import {
  createWorkflowResourceDraft, getWorkflowResourceById, previewWorkflowImpact,
  publishWorkflowResource,
} from '../src/workflow_repository.js';

// Exact normalized JSON produced by the historical UTF-16 and later locale
// writers for the same valid output configuration. Neither fixture needs Git
// or the current host's collation rules to run.
const FIXTURES = [
  ['historical-utf16', '{"A":"safe","a":"safe","mode":"audit_only"}'],
  ['historical-locale', '{"a":"safe","A":"safe","mode":"audit_only"}'],
];
const digest = value => createHash('sha256').update(value).digest('hex');
const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-workflow-hash-compatibility-'));
try {
  await initDb(path.join(directory, 'forwarder.db'));
  const db = getDatabase();
  const resources = [];
  for (const [name, serialized] of FIXTURES) {
    const draft = await createWorkflowResourceDraft({ kind: 'output', name,
      configuration: { mode: 'audit_only', A: 'safe', a: 'safe' } });
    await db.run('UPDATE workflow_resource_versions SET configuration_json=?,configuration_sha256=? WHERE id=?',
      [serialized, digest(serialized), draft.id]);
    const before = await db.get('SELECT configuration_json,configuration_sha256 FROM workflow_resource_versions WHERE id=?', [draft.id]);
    const restored = await getWorkflowResourceById(draft.id);
    assert.deepEqual(restored.configuration, { A: 'safe', a: 'safe', mode: 'audit_only' });
    assert.equal(restored.configurationSha256, digest(serialized));
    assert.deepEqual(await db.get('SELECT configuration_json,configuration_sha256 FROM workflow_resource_versions WHERE id=?', [draft.id]), before);
    await db.run('UPDATE workflow_resource_versions SET configuration_json=? WHERE id=?',
      [serialized.replace('"A":"safe"', '"A":"tampered"'), draft.id]);
    await assert.rejects(getWorkflowResourceById(draft.id), /failed its integrity check/);
    await db.run('UPDATE workflow_resource_versions SET configuration_json=? WHERE id=?', [serialized, draft.id]);
    resources.push(await publishWorkflowResource(draft.id));
  }
  const fresh = await createWorkflowResourceDraft({ kind: 'output', name: 'deterministic-new-writer',
    configuration: { a: 'safe', mode: 'audit_only', A: 'safe' } });
  assert.equal(fresh.configurationSha256, digest(FIXTURES[0][1]));
  assert.equal((await db.get('SELECT configuration_json FROM workflow_resource_versions WHERE id=?', [fresh.id])).configuration_json, FIXTURES[0][1]);
  await assert.rejects(previewWorkflowImpact({ baseRevisionId: null, graph: { schemaVersion: 1,
    nodes: resources.map((resource, index) => ({ id: `output-${index}`, kind: 'output', resourceVersionId: resource.id, position: { x: 0, y: index * 150 } })),
    edges: [] } }), /identical behavior and may only be placed once/);
  console.log('Workflow hash compatibility resource tests passed.');
} finally {
  await closeDb();
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(directory).startsWith('tsx-workflow-hash-compatibility-'));
  await rm(directory, { recursive: true, force: true });
}
