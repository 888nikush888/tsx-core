import assert from 'node:assert/strict';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const maximumChunkBytes = 500 * 1024;
const npmExecutable = process.platform === 'win32' ? 'cmd.exe' : 'npm';
const npmArguments = process.platform === 'win32'
  ? ['/d', '/s', '/c', 'npm run build --prefix frontend']
  : ['run', 'build', '--prefix', 'frontend'];
const build = spawnSync(npmExecutable, npmArguments, {
  cwd: process.cwd(),
  encoding: 'utf8',
  shell: false,
  timeout: 120_000,
  windowsHide: true,
});

assert.equal(
  build.status,
  0,
  `Frontend production build failed:\n${build.stdout}\n${build.stderr}`,
);

const assetsDirectory = path.resolve('frontend/dist/assets');
const chunks = [];
for (const name of await readdir(assetsDirectory)) {
  if (!name.endsWith('.js')) continue;
  const details = await stat(path.join(assetsDirectory, name));
  chunks.push({ name, bytes: details.size });
}

assert.ok(chunks.length > 0, 'Frontend production build must emit JavaScript chunks.');
const oversized = chunks.filter(chunk => chunk.bytes > maximumChunkBytes);
assert.deepEqual(
  oversized,
  [],
  `Frontend chunks must stay at or below ${maximumChunkBytes} bytes: ${JSON.stringify(oversized)}`,
);
assert.doesNotMatch(
  `${build.stdout}\n${build.stderr}`,
  /Some chunks are larger than 500 kB/,
  'Frontend build must not emit the large-chunk warning.',
);

console.log('Frontend production bundle budget test passed.');
