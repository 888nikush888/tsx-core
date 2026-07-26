import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.join(root, 'src');

async function listTypeScriptFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listTypeScriptFiles(fullPath)));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(fullPath);
  }
  return files;
}

function moduleName(filePath) {
  return path.relative(sourceRoot, filePath).replaceAll(path.sep, '/');
}

async function resolveLocalImport(importer, specifier) {
  const base = path.resolve(path.dirname(importer), specifier.replace(/\.js$/, ''));
  const candidates = [`${base}.ts`, path.join(base, 'index.ts')];
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return undefined;
}

function findCycle(graph) {
  const visited = new Set();
  const active = new Set();
  const stack = [];

  function visit(module) {
    if (active.has(module)) return [...stack.slice(stack.indexOf(module)), module];
    if (visited.has(module)) return undefined;
    visited.add(module);
    active.add(module);
    stack.push(module);
    for (const dependency of graph.get(module) ?? []) {
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    stack.pop();
    active.delete(module);
    return undefined;
  }

  for (const module of graph.keys()) {
    const cycle = visit(module);
    if (cycle) return cycle;
  }
  return undefined;
}

async function buildImportGraph(files) {
  const graph = new Map(files.map((file) => [moduleName(file), []]));
  const violations = [];
  const importPattern = /(?:\bfrom\s*|\bimport\s*\(\s*)['"](\.[^'"]+)['"]/g;

  for (const file of files) {
    const content = await readFile(file, 'utf8');
    for (const match of content.matchAll(importPattern)) {
      const resolved = await resolveLocalImport(file, match[1]);
      if (!resolved) {
        violations.push(`${moduleName(file)} imports missing local module ${match[1]}`);
        continue;
      }
      const dependency = moduleName(resolved);
      if (!graph.has(dependency)) {
        violations.push(`${moduleName(file)} imports outside src: ${match[1]}`);
        continue;
      }
      graph.get(moduleName(file)).push(dependency);
    }
  }
  return { graph, violations };
}

function architectureLayerViolations(graph) {
  const violations = [];

  const entryPoints = new Set([
    'forwarder.ts',
    'mcp_server.ts',
    'backup_cli.ts',
    'migration_cli.ts',
    'audit_cli.ts',
  ]);
  const coreModules = new Set([
    'config.ts',
    'crash_guard.ts',
    'db.ts',
    'delivery_tracker.ts',
    'env.ts',
    'filters.ts',
    'metrics_tracker.ts',
    'queue.ts',
    'runtime_profile.ts',
    'runtime_settings.ts',
    'secret_store.ts',
    'signal_schema.ts',
    'telegram_login.ts',
    'tdlib_retry.ts',
    'trading_decimal.ts',
    'trading_risk.ts',
    'trading_strategy.ts',
    'trading_types.ts',
  ]);
  const outerModules = new Set([
    ...entryPoints,
    'backup.ts',
    'signal_parser.ts',
    'logger.ts',
    'web_server.ts',
    'official_exchange.ts',
    'paper_exchange.ts',
    'trading_credentials.ts',
    'trading_engine.ts',
    'trading_repository.ts',
    'trading_runtime.ts',
    'trading_web_control.ts',
  ]);

  for (const [module, dependencies] of graph) {
    for (const dependency of dependencies) {
      if (!entryPoints.has(module) && entryPoints.has(dependency)) {
        violations.push(`${module} must not import entry point ${dependency}`);
      }
      if (coreModules.has(module) && outerModules.has(dependency)) {
        violations.push(`core module ${module} must not import outer module ${dependency}`);
      }
      if (module === 'db.ts')
        violations.push(`db.ts must not import internal module ${dependency}`);
    }
  }
  return violations;
}

export async function analyzeArchitecture() {
  const files = await listTypeScriptFiles(sourceRoot);
  const { graph, violations } = await buildImportGraph(files);

  const cycle = findCycle(graph);
  if (cycle) violations.push(`circular dependency: ${cycle.join(' -> ')}`);
  violations.push(...architectureLayerViolations(graph));
  return { graph, violations };
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(fileURLToPath(import.meta.url))) {
  const { graph, violations } = await analyzeArchitecture();
  if (violations.length > 0) {
    for (const violation of violations) console.error(`ARCHITECTURE VIOLATION: ${violation}`);
    process.exitCode = 1;
  } else {
    const edges = [...graph.values()].reduce((sum, dependencies) => sum + dependencies.length, 0);
    console.log(
      `Architecture gate passed (${graph.size} modules, ${edges} internal imports, 0 cycles).`
    );
  }
}
