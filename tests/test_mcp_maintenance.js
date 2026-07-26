import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  beginMcpSharedMaintenance,
  clearMcpMaintenanceMarker,
  databaseFileIdentity,
  mcpMaintenanceActive,
  mcpMaintenanceMarkerPath,
} from '../src/mcp_maintenance.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-mcp-maintenance-'));
const databasePath = path.join(directory, 'forwarder.db');

try {
  await writeFile(databasePath, 'database');
  assert.equal(mcpMaintenanceMarkerPath(databasePath), path.join(directory, '.mcp-maintenance'));
  assert.equal(await mcpMaintenanceActive(databasePath), false);
  assert.match(await databaseFileIdentity(databasePath), /^\d+:\d+$/);
  await assert.rejects(beginMcpSharedMaintenance('bad\nreason', databasePath), /reason is invalid/);

  const maintenance = await beginMcpSharedMaintenance('test reset coordination', databasePath);
  assert.equal(await mcpMaintenanceActive(databasePath), true);
  await assert.rejects(
    beginMcpSharedMaintenance('second maintenance owner', databasePath),
    /already active/,
  );
  await maintenance.release();
  await maintenance.release();
  assert.equal(await mcpMaintenanceActive(databasePath), false);

  const second = await beginMcpSharedMaintenance('test marker cleanup', databasePath);
  assert.equal(await mcpMaintenanceActive(databasePath), true);
  await clearMcpMaintenanceMarker(databasePath);
  assert.equal(await mcpMaintenanceActive(databasePath), false);
  await second.release();

  await rm(databasePath);
  await assert.rejects(databaseFileIdentity(databasePath), /ENOENT/);
} finally {
  await rm(directory, { recursive: true, force: true });
}

console.log('MCP shared-maintenance coordination tests passed.');
