import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const policies = [
  {
    name: 'backend',
    lockfile: path.join(root, 'package-lock.json'),
    allowed: new Set([
      '0BSD',
      'Apache-2.0',
      'BlueOak-1.0.0',
      'BSD-3-Clause',
      'ISC',
      'MIT',
      '(MIT OR WTFPL)',
      '(BSD-2-Clause OR MIT OR Apache-2.0)',
    ]),
  },
  {
    name: 'frontend',
    lockfile: path.join(root, 'frontend', 'package-lock.json'),
    allowed: new Set(['0BSD', 'Apache-2.0', 'BSD-3-Clause', 'ISC', 'MIT', 'MIT AND ISC']),
  },
];

function packageName(lockPath) {
  return lockPath.slice(lockPath.lastIndexOf('node_modules/') + 'node_modules/'.length);
}

for (const policy of policies) {
  const lock = JSON.parse(await readFile(policy.lockfile, 'utf8'));
  if (lock.lockfileVersion !== 3 || !lock.packages) {
    throw new Error(`${policy.name} requires an npm lockfileVersion 3 package map.`);
  }
  const productionPackages = Object.entries(lock.packages).filter(
    ([lockPath, metadata]) => lockPath.includes('node_modules/') && !metadata.dev && !metadata.link
  );
  const violations = productionPackages.flatMap(([lockPath, metadata]) => {
    if (!metadata.license) return [`${packageName(lockPath)} has no declared license`];
    if (!policy.allowed.has(metadata.license)) {
      return [`${packageName(lockPath)} uses disallowed license ${metadata.license}`];
    }
    return [];
  });
  if (violations.length > 0) {
    for (const violation of violations) console.error(`${policy.name}: ${violation}`);
    process.exitCode = 1;
  } else {
    console.log(
      `${policy.name} production license gate passed (${productionPackages.length} locked artifacts).`
    );
  }
}
