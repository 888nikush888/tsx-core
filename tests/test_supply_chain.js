import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflow = await readFile(path.join(root, '.github', 'workflows', 'quality.yml'), 'utf8');
const stagingWorkflow = await readFile(path.join(root, '.github', 'workflows', 'staging.yml'), 'utf8');
const syntheticWorkflow = await readFile(path.join(root, '.github', 'workflows', 'synthetic.yml'), 'utf8');
const productionEvidenceWorkflow = await readFile(path.join(root, '.github', 'workflows', 'production_evidence.yml'), 'utf8');
const dockerfile = await readFile(path.join(root, 'Dockerfile'), 'utf8');
const executorDockerfile = await readFile(path.join(root, 'exchange_executor', 'Dockerfile'), 'utf8');
const executorLock = await readFile(path.join(root, 'exchange_executor', 'requirements.lock'), 'utf8');
const hyperliquidAdapter = await readFile(path.join(root, 'exchange_executor', 'hyperliquid_adapter.py'), 'utf8');
const bybitAdapter = await readFile(path.join(root, 'exchange_executor', 'bybit_adapter.py'), 'utf8');
const dockerCompose = await readFile(path.join(root, 'docker-compose.yml'), 'utf8');
const strykerConfig = await readFile(path.join(root, 'stryker.config.mjs'), 'utf8');
const mutationRunner = await readFile(path.join(root, 'scripts', 'run_mutation_shards.js'), 'utf8');

const allWorkflows = `${workflow}\n${stagingWorkflow}\n${syntheticWorkflow}\n${productionEvidenceWorkflow}`;
const actionReferences = [...allWorkflows.matchAll(/^\s*uses:\s*([^\s#]+).*$/gm)].map(
  (match) => match[1]
);
assert.ok(actionReferences.length > 0, 'quality workflow must use pinned actions');
for (const reference of actionReferences) {
  assert.match(
    reference,
    /^[^@\s]+@[a-f0-9]{40}$/,
    `action reference must use a full SHA: ${reference}`
  );
}

const safeTrivyAction = 'aquasecurity/trivy-action@57a97c7e7821a5776cebc9bb87c984fa69cba8f1';
assert.equal(
  actionReferences.filter((reference) => reference === safeTrivyAction).length,
  8,
  'all Trivy steps must use the known-safe action commit'
);
assert.equal((workflow.match(/^\s*version:\s*v0\.69\.3\s*$/gm) ?? []).length, 8);
assert.doesNotMatch(workflow, /^\s*version:\s*latest\s*$/m);
assert.doesNotMatch(
  workflow,
  /aquasecurity\/trivy-action@b6643a29fecd7f34b3597bc6acb0a98b03d33ff8/
);

assert.match(workflow, /shard:\s*\[queue, retry, schema\]/);
assert.match(workflow, /npm run test:mutation -- \$\{\{ matrix\.shard \}\}/);
assert.match(strykerConfig, /process\.env\.STRYKER_SHARD/);
assert.match(strykerConfig, /cleanTempDir:\s*'always'/);
assert.match(strykerConfig, /concurrency:\s*1/);
assert.match(mutationRunner, /timeout:\s*20 \* 60_000/);
assert.match(workflow, /cron:\s*'17 3 \* \* 1'/);
assert.doesNotMatch(workflow, /ignore-unfixed:\s*true/);
assert.match(workflow, /retention-days:\s*90/);
assert.match(workflow, /needs:\s*\[verify, mutation, sast, secrets, container\]/);
assert.match(workflow, /repos\/\$\{GITHUB_REPOSITORY\}\/immutable-releases/);
assert.match(workflow, /actions\/download-artifact@634f93cb2916e3fdff6788551b99b062d0335ce0/);
assert.match(workflow, /actions\/attest@f6bf1532d7d6793fce74eac584813a8eee607999/);
assert.match(workflow, /gh release verify "\$GITHUB_REF_NAME"/);

const baseImages = [...dockerfile.matchAll(/^FROM\s+([^\s]+).*$/gm)].map((match) => match[1]);
assert.ok(baseImages.length > 0, 'Dockerfile must declare a base image');
const nodeImage = dockerfile.match(/^ARG NODE_IMAGE=([^\s]+)$/m)?.[1];
const runtimeImage = dockerfile.match(/^ARG RUNTIME_IMAGE=([^\s]+)$/m)?.[1];
assert.ok(nodeImage, 'Dockerfile must define NODE_IMAGE');
assert.ok(runtimeImage, 'Dockerfile must define RUNTIME_IMAGE');
assert.match(nodeImage, /@sha256:[a-f0-9]{64}$/, 'NODE_IMAGE must use a sha256 digest');
assert.match(runtimeImage, /@sha256:[a-f0-9]{64}$/, 'RUNTIME_IMAGE must use a sha256 digest');
assert.doesNotMatch(nodeImage, /:latest(?:@|$)/, 'NODE_IMAGE must not use latest');
assert.doesNotMatch(runtimeImage, /:latest(?:@|$)/, 'RUNTIME_IMAGE must not use latest');
assert.match(runtimeImage, /^gcr\.io\/distroless\/nodejs22-debian13@sha256:/);
assert.equal(baseImages[0], '${NODE_IMAGE}', 'base stage must use the pinned NODE_IMAGE argument');
assert.ok(
  baseImages.slice(1, -1).every((image) => image === 'base'),
  'all build stages must inherit the pinned build base'
);
assert.equal(baseImages.at(-1), '${RUNTIME_IMAGE}', 'runner must use the pinned distroless image');
assert.match(dockerfile, /^ARG DEBIAN_SNAPSHOT=\d{8}T\d{6}Z$/m);
assert.match(dockerfile, /snapshot\.debian\.org\/archive\/debian\/\$\{DEBIAN_SNAPSHOT\}/);
assert.match(dockerfile, /snapshot\.debian\.org\/archive\/debian-security\/\$\{DEBIAN_SNAPSHOT\}/);
const runtimeStage = dockerfile.slice(dockerfile.indexOf('FROM ${RUNTIME_IMAGE} AS runner'));
assert.doesNotMatch(runtimeStage, /^RUN\s/m, 'distroless runtime must not install packages');
assert.match(runtimeStage, /^USER 65532:65532$/m);
assert.match(runtimeStage, /^CMD \["dist\/forwarder\.js"\]$/m);
assert.doesNotMatch(dockerCompose, /^\s*env_file:/m, 'default Docker runtime must not import workspace .env secrets');
assert.match(dockerCompose, /^\s*restart:\s*unless-stopped\s*$/m);
assert.match(dockerCompose, /^\s*stop_grace_period:\s*8m\s*$/m);
assert.match(dockerCompose, /RUNTIME_SETTINGS_PATH:\s*"\/app\/config\/runtime-settings\.json"/);
assert.match(dockerCompose, /"127\.0\.0\.1:\$\{HOST_WEB_PORT:-8080\}:8080"/);
assert.match(executorDockerfile, /^ARG PYTHON_IMAGE=python:3\.12\.11-slim-bookworm@sha256:[a-f0-9]{64}$/m);
assert.match(executorDockerfile, /^USER 65532:65532$/m);
assert.match(executorDockerfile, /pip install --require-hashes/);
assert.match(executorLock, /^hyperliquid-python-sdk==0\.24\.0 \\/m);
assert.match(executorLock, /^pybit==5\.16\.0 \\/m);
assert.match(executorLock, /f472dd4f6d8ef0e66182c7627276400462c86fbc0929eb5b63feda3ae45605f6/);
assert.match(executorLock, /d214c4987aabb25c10e8e031244973a3be4728e044575ab6c6f6f7873f8c1cab/);
assert.match(hyperliquidAdapter, /from hyperliquid\.exchange import Exchange/);
assert.match(hyperliquidAdapter, /from hyperliquid\.info import Info/);
assert.match(bybitAdapter, /from pybit\.unified_trading import HTTP/);
const executorService = dockerCompose.slice(
  dockerCompose.indexOf('\n  exchange-executor:'),
  dockerCompose.indexOf('\nvolumes:'),
);
assert.ok(executorService.length > 0, 'compose must define the exchange executor service');
assert.doesNotMatch(executorService, /^\s+ports:/m);
assert.match(dockerCompose, /forwarder_secrets:\/app\/secrets:ro/);

console.log('Supply-chain pinning policy tests passed.');
