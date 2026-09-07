import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function relativeSource(root, filename) {
  const relative = path.relative(root, filename);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('LCOV source is outside the repository.');
  }
  return relative.split(path.sep).join('/');
}

export async function normalizeLcov(content, { repositoryRoot, sourceRoot = repositoryRoot }) {
  const root = await realpath(repositoryRoot);
  const sourceDirectory = await realpath(sourceRoot);
  let sourceCount = 0;
  const normalized = [];
  for (const line of content.split(/\r?\n/u)) {
    if (!line.startsWith('SF:')) {
      normalized.push(line);
      continue;
    }
    const source = line.slice(3).replaceAll('\\', path.sep);
    if (!source) throw new Error('LCOV source is empty.');
    const resolved = path.resolve(sourceDirectory, source);
    relativeSource(root, resolved);
    // A report pointing at missing files or a symlink outside the repository is
    // invalid evidence. Never silently drop records to remove scanner warnings.
    const canonical = await realpath(resolved);
    const relative = relativeSource(root, canonical);
    if (!(await stat(canonical)).isFile()) throw new Error('LCOV source is not a file.');
    normalized.push(`SF:${relative}`);
    sourceCount += 1;
  }
  if (sourceCount === 0) throw new Error('LCOV report contains no source records.');
  return normalized.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const repositoryRoot = process.cwd();
  try {
    for (const [report, sourceRoot] of [['coverage/lcov.info', repositoryRoot], ['frontend/coverage/lcov.info', path.join(repositoryRoot, 'frontend')]]) {
      const content = await normalizeLcov(await readFile(report, 'utf8'), { repositoryRoot, sourceRoot });
      await writeFile(report, content, 'utf8');
    }
    console.log('LCOV source paths verified and normalized relative to the repository.');
  } catch (error) {
    console.error(`LCOV path validation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
