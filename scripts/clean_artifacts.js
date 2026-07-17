import { lstat, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const generatedArtifacts = [
  'dist',
  'frontend/dist',
  'coverage',
  'coverage-modules',
  'reports',
  '.stryker-tmp-queue',
  '.stryker-tmp-retry',
  '.stryker-tmp-schema'
];
const dryRun = process.argv.includes('--dry-run');

function resolveArtifact(relativePath) {
  const absolutePath = path.resolve(repositoryRoot, relativePath);
  if (!absolutePath.startsWith(`${repositoryRoot}${path.sep}`)) {
    throw new Error(`Refusing unsafe cleanup target: ${relativePath}`);
  }
  return absolutePath;
}

for (const relativePath of generatedArtifacts) {
  const absolutePath = resolveArtifact(relativePath);
  try {
    const metadata = await lstat(absolutePath);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`Refusing non-directory or symbolic-link cleanup target: ${relativePath}`);
    }
  } catch (error) {
    if (error?.code === 'ENOENT') continue;
    throw error;
  }

  if (dryRun) {
    console.log(`Would remove generated artifact: ${relativePath}`);
    continue;
  }
  await rm(absolutePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  console.log(`Removed generated artifact: ${relativePath}`);
}
