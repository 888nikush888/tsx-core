import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const frontendRoot = path.join(root, 'frontend');
const sourceRoot = path.join(frontendRoot, 'src');
// Reviewed pure modules shared with the browser. No adapter, Node, database or secret imports.
const sharedBrowserModules = new Set(['ui_contracts.ts', 'trading_decimal.ts'].map(name => path.join(root, 'src', name)));

async function listCode(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listCode(fullPath)));
    else if (entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      files.push(path.resolve(fullPath));
    }
  }
  return files;
}

function packageName(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

async function existingFile(candidates) {
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) return path.resolve(candidate);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return undefined;
}

async function resolveLocal(importer, specifier) {
  const base = specifier.startsWith('@/')
    ? path.join(sourceRoot, specifier.slice(2))
    : path.resolve(path.dirname(importer), specifier);
  const exact = await existingFile([base]);
  if (exact) return /\.(?:ts|tsx)$/.test(exact) && !exact.endsWith('.d.ts') ? exact : null;
  return existingFile([
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ]);
}

async function buildFrontendGraph(files) {
  const graph = new Map(files.map((file) => [file, []]));
  const externalByFile = new Map(files.map((file) => [file, []]));
  const violations = [];
  const importPattern = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s*|\bnew\s+URL\(\s*)['"]([^'"]+)['"]/g;

  const queue = [...files];
  for (const file of queue) {
    const content = await readFile(file, 'utf8');
    for (const match of content.matchAll(importPattern)) {
      const specifier = match[1];
      if (specifier.startsWith('.') || specifier.startsWith('@/')) {
        await connectLocalImport({ file, specifier, graph, externalByFile, queue, violations });
      } else {
        if (sharedBrowserModules.has(file)) violations.push(`Shared browser contract ${path.relative(root, file)} has an external import: ${specifier}`);
        externalByFile.get(file).push(packageName(specifier));
      }
    }
  }
  return { graph, externalByFile, violations, sharedFiles: queue.filter(file => sharedBrowserModules.has(file)) };
}

async function connectLocalImport({ file, specifier, graph, externalByFile, queue, violations }) {
  const dependency = await resolveLocal(file, specifier);
  if (dependency === undefined) {
    violations.push(`${path.relative(sourceRoot, file)} imports missing module ${specifier}`);
    return;
  }
  if (dependency === null) return;
  if (!dependency.startsWith(sourceRoot + path.sep) && !sharedBrowserModules.has(dependency)) {
    violations.push(`${path.relative(root, file)} imports non-browser module ${path.relative(root, dependency)}`);
    return;
  }
  graph.get(file).push(dependency);
  if (!graph.has(dependency)) {
    graph.set(dependency, []); externalByFile.set(dependency, []); queue.push(dependency);
  }
}

function dependencyViolations(productionPackages, usedPackages, availablePackages) {
  const violations = [];
  for (const dependency of productionPackages) {
    if (!usedPackages.has(dependency)) violations.push(`unused frontend production dependency: ${dependency}`);
  }
  for (const dependency of usedPackages) {
    if (!availablePackages.has(dependency)) violations.push(`undeclared frontend dependency: ${dependency}`);
  }
  return violations;
}

export async function analyzeFrontend() {
  const files = await listCode(sourceRoot);
  const { graph, externalByFile, violations, sharedFiles } = await buildFrontendGraph(files);

  const entryPoint = path.join(sourceRoot, 'main.tsx');
  const reachable = new Set();
  function visit(file) {
    if (reachable.has(file)) return;
    reachable.add(file);
    for (const dependency of graph.get(file) ?? []) visit(dependency);
  }
  visit(entryPoint);

  const unreachable = files
    .filter((file) => !reachable.has(file))
    .map((file) => path.relative(sourceRoot, file).replaceAll(path.sep, '/'))
    .sort();
  violations.push(...unreachable.map((file) => `unreachable frontend module: ${file}`));

  const usedPackages = new Set([...reachable].flatMap((file) => externalByFile.get(file) ?? []));
  const manifest = JSON.parse(await readFile(path.join(frontendRoot, 'package.json'), 'utf8'));
  const productionPackages = Object.keys(manifest.dependencies ?? {});
  const availablePackages = new Set([
    ...productionPackages,
    ...Object.keys(manifest.devDependencies ?? {}),
  ]);
  violations.push(...dependencyViolations(productionPackages, usedPackages, availablePackages));

  return { files, sharedFiles, reachable, usedPackages, violations };
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(fileURLToPath(import.meta.url))) {
  const result = await analyzeFrontend();
  if (result.violations.length > 0) {
    for (const violation of result.violations) console.error(`FRONTEND QUALITY VIOLATION: ${violation}`);
    process.exitCode = 1;
  } else {
    console.log(
      `Frontend gate passed (${result.reachable.size}/${result.files.length + result.sharedFiles.length} modules reachable, including ${result.sharedFiles.length} pure shared modules; ${result.usedPackages.size} production packages used).`
    );
  }
}
