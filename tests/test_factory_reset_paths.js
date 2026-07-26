import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assertFactoryResetTarget,
  clearFactoryResetTarget,
} from '../src/factory_reset_paths.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-reset-paths-'));
try {
  const applicationRoot = path.join(directory, 'checkout');
  const externalRoot = path.join(directory, 'state', 'telegram-tdlib-forwarder', 'secrets');
  await mkdir(applicationRoot, { recursive: true });
  await mkdir(externalRoot, { recursive: true });
  await writeFile(path.join(externalRoot, 'dashboard_admin_token'), 'secret');
  await writeFile(path.join(externalRoot, '.mcp-maintenance'), 'maintenance');

  const exactBoundary = {
    kind: 'exact-managed-secret',
    configuredRoot: externalRoot,
    applicationRoot,
  };
  assert.equal(await assertFactoryResetTarget(externalRoot, exactBoundary), await realpath(externalRoot));
  await clearFactoryResetTarget(externalRoot, exactBoundary, ['.mcp-maintenance']);
  await assert.rejects(readFile(path.join(externalRoot, 'dashboard_admin_token')), /ENOENT/);
  assert.equal(
    await readFile(path.join(externalRoot, '.mcp-maintenance'), 'utf8'),
    'maintenance',
    'Factory reset must be able to preserve the cross-process MCP maintenance marker.',
  );
  await assert.rejects(
    clearFactoryResetTarget(externalRoot, exactBoundary, ['../unsafe']),
    /preserve name is invalid/,
  );

  await assert.rejects(
    assertFactoryResetTarget(path.join(directory, 'state'), exactBoundary),
    /unconfigured managed-secret path/,
  );
  await assert.rejects(
    assertFactoryResetTarget(directory, { kind: 'application', applicationRoot }),
    /outside the application root/,
  );
  await assert.rejects(
    assertFactoryResetTarget(applicationRoot, {
      kind: 'exact-managed-secret', configuredRoot: applicationRoot, applicationRoot,
    }),
    /protected root/,
  );
  const driveLeaf = path.join(path.parse(directory).root, 'factory-reset-shallow-leaf');
  await assert.rejects(
    assertFactoryResetTarget(driveLeaf, {
      kind: 'exact-managed-secret', configuredRoot: driveLeaf, applicationRoot,
    }),
    /nested managed-secret directory/,
  );

  const fileTarget = path.join(directory, 'file-target');
  await writeFile(fileTarget, 'retain');
  await assert.rejects(
    assertFactoryResetTarget(fileTarget, {
      kind: 'exact-managed-secret', configuredRoot: fileTarget, applicationRoot,
    }),
    /must be a real directory/,
  );

  const outside = path.join(directory, 'outside');
  const applicationData = path.join(applicationRoot, 'logs');
  await mkdir(outside, { recursive: true });
  await mkdir(applicationData, { recursive: true });
  await writeFile(path.join(outside, 'sentinel'), 'retain');
  await symlink(outside, path.join(applicationData, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir');
  await clearFactoryResetTarget(applicationData, { kind: 'application', applicationRoot });
  assert.equal(await readFile(path.join(outside, 'sentinel'), 'utf8'), 'retain', 'Reset must unlink, not traverse, a child symlink.');

  const linkedRoot = path.join(directory, 'linked-root');
  await symlink(outside, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(
    assertFactoryResetTarget(linkedRoot, {
      kind: 'exact-managed-secret', configuredRoot: linkedRoot, applicationRoot,
    }),
    /real directory|symbolic link or junction/,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}

console.log('Factory-reset path boundary tests passed.');
