import { mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';

const MARKER_NAME = '.mcp-maintenance';

export function operationalDatabasePath(): string {
  return path.resolve(
    process.env.FORWARDER_DB_PATH || path.join(process.cwd(), 'session_data', 'forwarder.db'),
  );
}

export function mcpMaintenanceMarkerPath(databasePath = operationalDatabasePath()): string {
  return path.join(path.dirname(path.resolve(databasePath)), MARKER_NAME);
}

export async function mcpMaintenanceActive(databasePath = operationalDatabasePath()): Promise<boolean> {
  try {
    const marker = await stat(mcpMaintenanceMarkerPath(databasePath));
    return marker.isFile() && !marker.isSymbolicLink();
  } catch (error: any) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export async function beginMcpSharedMaintenance(
  reason: string,
  databasePath = operationalDatabasePath(),
): Promise<{ markerPath: string; release: () => Promise<void> }> {
  const normalized = reason.trim();
  if (!normalized || normalized.length > 200 || /[\r\n\0]/.test(normalized)) {
    throw new Error('MCP shared maintenance reason is invalid.');
  }
  const markerPath = mcpMaintenanceMarkerPath(databasePath);
  await mkdir(path.dirname(markerPath), { recursive: true, mode: 0o700 });
  const handle = await open(markerPath, 'wx', 0o600).catch(async (error: any) => {
    if (error?.code !== 'EEXIST') throw error;
    const existing = await readFile(markerPath, 'utf8').catch(() => 'unreadable marker');
    throw new Error(`MCP shared maintenance is already active: ${existing.slice(0, 500)}`);
  });
  try {
    await handle.writeFile(JSON.stringify({ reason: normalized, pid: process.pid, createdAt: Date.now() }));
    await handle.sync();
  } finally {
    await handle.close();
  }
  // The independent MCP service polls this marker every 250 ms. Waiting four
  // intervals closes its SQLite handle before a reset or restore replaces files.
  await new Promise(resolve => setTimeout(resolve, 1_000));
  let released = false;
  return {
    markerPath,
    async release() {
      if (released) return;
      released = true;
      await rm(markerPath, { force: true });
    },
  };
}

export async function clearMcpMaintenanceMarker(
  databasePath = operationalDatabasePath(),
): Promise<void> {
  await rm(mcpMaintenanceMarkerPath(databasePath), { force: true });
}

export async function databaseFileIdentity(
  databasePath = operationalDatabasePath(),
): Promise<string> {
  const information = await stat(path.resolve(databasePath));
  if (!information.isFile() || information.isSymbolicLink()) {
    throw new Error('Operational database path is not a regular file.');
  }
  return `${information.dev}:${information.ino}`;
}
