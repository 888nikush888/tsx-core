import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type FactoryResetBoundary =
  | { kind: 'application'; applicationRoot: string }
  | { kind: 'exact-managed-secret'; configuredRoot: string; applicationRoot: string };

function comparable(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isStrictDescendant(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative.length > 0 && relative !== '..'
    && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function assertSafeExactLeaf(root: string, applicationRoot: string): void {
  const protectedRoots = [path.parse(root).root, os.homedir(), applicationRoot];
  if (protectedRoots.some(protectedRoot => comparable(root) === comparable(protectedRoot))) {
    throw new Error(`Factory reset refuses to erase a protected root: ${root}`);
  }
  if (comparable(path.dirname(root)) === comparable(path.parse(root).root)) {
    throw new Error(`Factory reset requires a nested managed-secret directory: ${root}`);
  }
}

/**
 * Resolves and materializes a reset target without accepting symlink/junction
 * aliases. Application data must remain below the checkout; only the exact
 * ManagedSecretStore root may use the dedicated external boundary.
 */
export async function assertFactoryResetTarget(
  directory: string,
  boundary: FactoryResetBoundary,
): Promise<string> {
  const root = path.resolve(directory);
  const applicationRoot = path.resolve(boundary.applicationRoot);
  if (boundary.kind === 'application') {
    if (!isStrictDescendant(root, applicationRoot)) {
      throw new Error(`Factory reset refuses to erase a path outside the application root: ${root}`);
    }
  } else {
    const configuredRoot = path.resolve(boundary.configuredRoot);
    if (comparable(root) !== comparable(configuredRoot)) {
      throw new Error(`Factory reset refuses an unconfigured managed-secret path: ${root}`);
    }
    assertSafeExactLeaf(root, applicationRoot);
  }

  await fs.mkdir(root, { recursive: true, mode: 0o700 }).catch((error: any) => {
    if (error?.code !== 'EEXIST') throw error;
  });
  const stats = await fs.lstat(root);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Factory reset path must be a real directory: ${root}`);
  }
  const canonical = await fs.realpath(root);
  if (comparable(canonical) !== comparable(root)) {
    throw new Error(`Factory reset path must not traverse a symbolic link or junction: ${root}`);
  }
  if (boundary.kind === 'application') {
    const canonicalApplicationRoot = await fs.realpath(applicationRoot);
    if (!isStrictDescendant(canonical, canonicalApplicationRoot)) {
      throw new Error(`Factory reset resolved outside the application root: ${root}`);
    }
  }
  return canonical;
}

export async function clearFactoryResetTarget(
  directory: string,
  boundary: FactoryResetBoundary,
  preserveNames: readonly string[] = [],
): Promise<void> {
  const root = await assertFactoryResetTarget(directory, boundary);
  const preserved = new Set(preserveNames);
  if ([...preserved].some(name => !/^[a-z0-9._-]{1,80}$/i.test(name))) {
    throw new Error('Factory reset preserve name is invalid.');
  }
  for (const entry of await fs.readdir(root)) {
    if (preserved.has(entry)) continue;
    const target = path.join(root, entry);
    const stats = await fs.lstat(target);
    if (stats.isSymbolicLink()) await fs.unlink(target);
    else await fs.rm(target, { recursive: true, force: true });
  }
}
