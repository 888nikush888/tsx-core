import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gitExecutable = process.platform === 'win32'
  ? String.raw`C:\Program Files\Git\cmd\git.exe`
  : '/usr/bin/git';
const requiredIgnores = [
  '.git', '.env', '.env.*', 'config.json', 'node_modules', 'frontend/node_modules',
  'secrets', '**/secrets', '**/.managed-secret-transaction.json', 'session_data', 'tmp',
  'session_files', 'logs', 'backups', '*.tgfb',
];
const sensitiveDirectory = /(^|\/)(?:secrets?|session_data|session_files|backups)(?:\/|$)/i;
const environmentFile = /(^|\/)\.env(?:\.|$)/i;

function isSensitiveTrackedPath(file) {
  return sensitiveDirectory.test(file) || environmentFile.test(file) || file.toLowerCase().endsWith('.tgfb');
}

export function evaluateBuildContext({ dockerignore, dockerfile, trackedFiles }) {
  const rules = new Set(dockerignore.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#')));
  const violations = requiredIgnores.filter(rule => !rules.has(rule)).map(rule => `.dockerignore is missing ${rule}`);
  const copiesWorkspaceRoot = dockerfile.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('COPY ') && !trimmed.startsWith('ADD ')) return false;
    const argumentText = trimmed.slice(trimmed.indexOf(' ') + 1).trim();
    if (argumentText.startsWith('[')) {
      try {
        const values = JSON.parse(argumentText);
        return values.slice(0, -1).some(value => value === '.' || value === './');
      } catch {
        return true;
      }
    }
    const values = argumentText.split(/\s+/).filter(value => !value.startsWith('--'));
    return values.slice(0, -1).some(value => value === '.' || value === './');
  });
  if (copiesWorkspaceRoot) {
    violations.push('Dockerfile must use an explicit COPY allowlist instead of copying or adding the workspace root');
  }
  for (const file of trackedFiles.map(value => value.replaceAll('\\', '/'))) {
    if (file === '.env.example') continue;
    if (isSensitiveTrackedPath(file)) violations.push(`sensitive runtime path is tracked: ${file}`);
  }
  return violations;
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(fileURLToPath(import.meta.url))) {
  const [dockerignore, dockerfile, executorDockerignore] = await Promise.all([
    readFile(path.join(root, '.dockerignore'), 'utf8'),
    readFile(path.join(root, 'Dockerfile'), 'utf8'),
    readFile(path.join(root, 'exchange_executor', '.dockerignore'), 'utf8'),
  ]);
  // Names only: the gate deliberately never opens possible secret files.
  const trackedFiles = execFileSync(gitExecutable, ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const violations = evaluateBuildContext({ dockerignore, dockerfile, trackedFiles });
  const executorRules = new Set(executorDockerignore.split(/\r?\n/).map(line => line.trim()).filter(Boolean));
  for (const rule of ['.env', '.env.*', 'secrets', '**/secrets']) {
    if (!executorRules.has(rule)) violations.push(`exchange_executor/.dockerignore is missing ${rule}`);
  }
  if (violations.length > 0) {
    for (const violation of violations) console.error(`BUILD CONTEXT VIOLATION: ${violation}`);
    process.exitCode = 1;
  } else {
    console.log('Build-context allowlist and tracked-path secret boundary passed.');
  }
}
