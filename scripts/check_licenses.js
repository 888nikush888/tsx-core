import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const productionLicenses = new Set([
  '0BSD', 'Apache-2.0', 'BlueOak-1.0.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC',
  'MIT', 'MIT-0', 'MPL-2.0', 'PSF-2.0', 'Apache-2.0 AND CNRI-Python',
  'MIT AND ISC', '(MIT OR WTFPL)',
  '(BSD-2-Clause OR MIT OR Apache-2.0)',
]);
const buildOnlyLicenses = new Set([...productionLicenses, 'CC-BY-4.0', 'CC0-1.0', 'MPL-2.0']);
const pythonPolicy = new Map([
  ['annotated-types@0.7.0', 'MIT'],
  ['bitarray@3.9.0', 'PSF-2.0'],
  ['certifi@2026.6.17', 'MPL-2.0'],
  ['charset-normalizer@3.4.9', 'MIT'],
  ['ckzg@2.1.8', 'Apache-2.0'],
  ['cytoolz@1.1.0', 'BSD-3-Clause'],
  ['eth-abi@5.2.0', 'MIT'],
  ['eth-account@0.13.7', 'MIT'],
  ['eth-hash@0.8.0', 'MIT'],
  ['eth-keyfile@0.8.1', 'MIT'],
  ['eth-keys@0.7.0', 'MIT'],
  ['eth-rlp@2.2.0', 'MIT'],
  ['eth-typing@6.0.0', 'MIT'],
  ['eth-utils@5.3.1', 'MIT'],
  ['hexbytes@1.3.1', 'MIT'],
  ['hyperliquid-python-sdk@0.24.0', 'MIT'],
  ['idna@3.18', 'BSD-3-Clause'],
  ['msgpack@1.2.1', 'Apache-2.0'],
  ['parsimonious@0.10.0', 'MIT'],
  ['pybit@5.16.0', 'MIT'],
  ['pycryptodome@3.23.0', 'BSD-2-Clause'],
  ['pydantic@2.13.4', 'MIT'],
  ['pydantic-core@2.46.4', 'MIT'],
  ['regex@2026.7.10', 'Apache-2.0 AND CNRI-Python'],
  ['requests@2.34.2', 'Apache-2.0'],
  ['rlp@4.1.0', 'MIT'],
  ['toolz@1.1.0', 'BSD-3-Clause'],
  ['typing-extensions@4.16.0', 'PSF-2.0'],
  ['typing-inspection@0.4.2', 'MIT'],
  ['urllib3@2.7.0', 'MIT'],
  ['websocket-client@1.9.0', 'Apache-2.0'],
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
  const requirements = [...lockedContent.matchAll(/^([A-Za-z0-9_.-]+)==([^\s\\]+)\s+\\$/gm)]
    .map(([, name, version]) => `${name}==${version}`);
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
    const match = requirement.match(/^([A-Za-z0-9_.-]+)==([A-Za-z0-9_.+-]+)$/);
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
