import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checker = path.join(
  root,
  'node_modules',
  'license-checker-rseidelsohn',
  'bin',
  'license-checker-rseidelsohn.js'
);

function verify(name, start, allowedLicenses, excludedPackages = '') {
  const args = [
    checker,
    '--production',
    '--start',
    start,
    '--onlyAllow',
    allowedLicenses,
    '--json',
  ];
  if (excludedPackages) args.push('--excludePackages', excludedPackages);
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    shell: false,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || `${name} license check failed.\n`);
    process.exit(result.status || 1);
  }
  const packages = JSON.parse(result.stdout);
  console.log(`${name} production license gate passed (${Object.keys(packages).length} packages).`);
}

verify(
  'backend',
  root,
  'MIT;ISC;BlueOak-1.0.0;Apache-2.0;0BSD;BSD-3-Clause;(MIT OR WTFPL);(BSD-2-Clause OR MIT OR Apache-2.0)'
);
verify(
  'frontend',
  path.join(root, 'frontend'),
  'MIT;ISC;Apache-2.0;BSD-3-Clause;MPL-2.0;0BSD;MIT AND ISC',
  'frontend@0.0.0'
);
