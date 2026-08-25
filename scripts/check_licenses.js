import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const productionLicenses = new Set([
  '0BSD', 'Apache-2.0', 'BlueOak-1.0.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC',
  'MIT', 'MIT-0', 'MPL-2.0', 'OFL-1.1', 'PSF-2.0', 'Apache-2.0 AND CNRI-Python',
  'MIT AND ISC', '(MIT OR WTFPL)',
  'Apache-2.0 AND MIT', 'MIT OR Apache-2.0', 'Apache-2.0 OR BSD-3-Clause',
  'MPL-2.0 AND (Apache-2.0 OR MIT)',
  '(BSD-2-Clause OR MIT OR Apache-2.0)',
]);
const buildOnlyLicenses = new Set([
  ...productionLicenses,
  'CC-BY-4.0',
  'CC0-1.0',
  'MPL-2.0',
  'Python-2.0',
]);
const pythonPolicy = new Map([
  ['aiohappyeyeballs@2.7.1', 'PSF-2.0'],
  ['aiohttp@3.14.3', 'Apache-2.0 AND MIT'],
  ['aiohttp-fast-zlib@0.3.0', 'Apache-2.0'],
  ['aiosignal@1.4.0', 'Apache-2.0'],
  ['attrs@26.1.0', 'MIT'],
  ['ccxt@4.5.75', 'MIT'],
  ['certifi@2026.6.17', 'MPL-2.0'],
  ['cffi@2.0.0', 'MIT'],
  ['charset-normalizer@3.4.7', 'MIT'],
  ['coincurve@21.0.0', 'MIT OR Apache-2.0'],
  ['cryptography@50.0.0', 'Apache-2.0 OR BSD-3-Clause'],
  ['frozenlist@1.8.0', 'Apache-2.0'],
  ['idna@3.18', 'BSD-3-Clause'],
  ['multidict@6.7.1', 'Apache-2.0'],
  ['orjson@3.11.9', 'MPL-2.0 AND (Apache-2.0 OR MIT)'],
  ['propcache@0.5.2', 'Apache-2.0'],
  ['pycparser@3.0', 'BSD-3-Clause'],
  ['requests@2.34.2', 'Apache-2.0'],
  ['typing-extensions@4.16.0', 'PSF-2.0'],
  ['urllib3@2.7.0', 'MIT'],
  ['uvloop@0.22.1', 'MIT OR Apache-2.0'],
  ['winloop@0.6.3', 'MIT OR Apache-2.0'],
  ['yarl@1.24.5', 'Apache-2.0'],
  ['zlib-ng@1.0.0', 'PSF-2.0'],
]);

function packageName(lockPath) {
  return lockPath.slice(lockPath.lastIndexOf('node_modules/') + 'node_modules/'.length);
}

export function evaluateNpmLicenses(name, lock) {
  const violations = [];
  const inventory = [];
  if (lock.lockfileVersion !== 3 || !lock.packages) {
    return { violations: [`${name} requires an npm lockfileVersion 3 package map`], inventory };
  }
  for (const [lockPath, metadata] of Object.entries(lock.packages)) {
    if (!lockPath.includes('node_modules/') || metadata.link) continue;
    const scope = metadata.dev ? 'build' : 'production';
    const artifact = `${packageName(lockPath)}@${metadata.version || 'unknown'}`;
    inventory.push({ ecosystem: 'npm', application: name, artifact, scope, license: metadata.license || null });
    if (!metadata.license) violations.push(`${name}: ${artifact} has no declared license`);
    else if (!(scope === 'production' ? productionLicenses : buildOnlyLicenses).has(metadata.license)) {
      violations.push(`${name}: ${artifact} uses disallowed ${scope} license ${metadata.license}`);
    }
  }
  return { violations, inventory };
}

export function evaluatePythonLockedRequirements(directContent, lockedContent) {
  const directRequirements = directContent.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  const requirements = lockedContent.split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => /^[A-Za-z0-9_.-]+==/.test(line) && line.endsWith('\\'))
    .map(line => line.slice(0, -1).trimEnd())
    .map(line => line.includes(';') ? line.slice(0, line.indexOf(';')).trimEnd() : line)
    .filter(line => /^[A-Za-z0-9_.-]+==[^\s;]+$/.test(line));
  const violations = [];
  const inventory = [];
  const lockedArtifacts = new Set(requirements.map(requirement => requirement.replace('==', '@')));
  for (const direct of directRequirements) {
    if (!/^[A-Za-z0-9_.-]+==[A-Za-z0-9_.+-]+$/.test(direct)) {
      violations.push(`python: direct requirement is not exactly pinned: ${direct}`);
    } else if (!lockedArtifacts.has(direct.replace('==', '@'))) {
      violations.push(`python: direct requirement is absent from the reviewed lock: ${direct}`);
    }
  }
  for (const requirement of requirements) {
    const match = /^([A-Za-z0-9_.-]+)==([A-Za-z0-9_.+-]+)$/.exec(requirement);
    const artifact = `${match[1]}@${match[2]}`;
    const license = pythonPolicy.get(artifact);
    inventory.push({ ecosystem: 'pypi', application: 'exchange-executor', artifact, scope: 'production', license: license || null });
    if (!license) violations.push(`python: ${artifact} has no reviewed license policy entry`);
    else if (!productionLicenses.has(license)) violations.push(`python: ${artifact} uses disallowed production license ${license}`);
  }
  for (const artifact of pythonPolicy.keys()) {
    if (!inventory.some(item => item.artifact === artifact)) violations.push(`python: reviewed policy entry is unused: ${artifact}`);
  }
  return { violations, inventory };
}

const [backendLock, frontendLock, pythonDirectRequirements, pythonLockedRequirements] = await Promise.all([
  readFile(path.join(root, 'package-lock.json'), 'utf8').then(JSON.parse),
  readFile(path.join(root, 'frontend', 'package-lock.json'), 'utf8').then(JSON.parse),
  readFile(path.join(root, 'exchange_executor', 'requirements.in'), 'utf8'),
  readFile(path.join(root, 'exchange_executor', 'requirements.lock'), 'utf8'),
]);
const results = [
  evaluateNpmLicenses('backend', backendLock),
  evaluateNpmLicenses('frontend', frontendLock),
  evaluatePythonLockedRequirements(pythonDirectRequirements, pythonLockedRequirements),
];
const violations = results.flatMap(result => result.violations);
const inventory = results.flatMap(result => result.inventory).sort((left, right) => left.artifact.localeCompare(right.artifact));
await mkdir(path.join(root, 'reports', 'licenses'), { recursive: true });
await writeFile(path.join(root, 'reports', 'licenses', 'inventory.json'), `${JSON.stringify({ schemaVersion: 1, artifacts: inventory }, null, 2)}\n`, 'utf8');
if (violations.length > 0) {
  for (const violation of violations) console.error(`LICENSE VIOLATION: ${violation}`);
  process.exitCode = 1;
} else {
  console.log(`License policy passed (${inventory.length} locked npm and reviewed Python artifacts).`);
}
