import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDeploymentImages } from '../scripts/verify_deployment_images.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflow = await readFile(path.join(root, '.github', 'workflows', 'quality.yml'), 'utf8');
const stagingWorkflow = await readFile(path.join(root, '.github', 'workflows', 'staging.yml'), 'utf8');
const syntheticWorkflow = await readFile(path.join(root, '.github', 'workflows', 'synthetic.yml'), 'utf8');
const productionEvidenceWorkflow = await readFile(path.join(root, '.github', 'workflows', 'production_evidence.yml'), 'utf8');
const dockerfile = await readFile(path.join(root, 'Dockerfile'), 'utf8');
const executorDockerfile = await readFile(path.join(root, 'exchange_executor', 'Dockerfile'), 'utf8');
const alertmanagerDockerfile = await readFile(path.join(root, 'monitoring', 'alertmanager.Dockerfile'), 'utf8');
const alertmanagerModuleLock = await readFile(path.join(root, 'monitoring', 'alertmanager.go.mod'), 'utf8');
const alertmanagerSumLock = await readFile(path.join(root, 'monitoring', 'alertmanager.go.sum'), 'utf8');
const vulncheckModuleLock = await readFile(path.join(root, 'monitoring', 'govulncheck', 'go.mod'), 'utf8');
const vulncheckSumLock = await readFile(path.join(root, 'monitoring', 'govulncheck', 'go.sum'), 'utf8');
const applicationVex = JSON.parse(await readFile(path.join(root, 'security', 'vex', 'CVE-2026-14456.openvex.json'), 'utf8'));
const monitoringCompose = await readFile(path.join(root, 'docker-compose.monitoring.yml'), 'utf8');
const executorLock = await readFile(path.join(root, 'exchange_executor', 'requirements.lock'), 'utf8');
const ccxtClient = await readFile(path.join(root, 'exchange_executor', 'ccxt_client.py'), 'utf8');
const ccxtAdapter = await readFile(path.join(root, 'exchange_executor', 'ccxt_adapter.py'), 'utf8');
const streamHub = await readFile(path.join(root, 'exchange_executor', 'stream_hub.py'), 'utf8');
const dockerCompose = await readFile(path.join(root, 'docker-compose.yml'), 'utf8');
const strykerConfig = await readFile(path.join(root, 'stryker.config.mjs'), 'utf8');
const mutationRunner = await readFile(path.join(root, 'scripts', 'run_mutation_shards.js'), 'utf8');
const gitleaksConfig = await readFile(path.join(root, '.gitleaks.toml'), 'utf8');

const allWorkflows = `${workflow}\n${stagingWorkflow}\n${syntheticWorkflow}\n${productionEvidenceWorkflow}`;
const actionReferences = [...allWorkflows.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+).*$/gm)].map(
  (match) => match[1]
);
assert.ok(actionReferences.length > 0, 'quality workflow must use pinned actions');
assert.match(gitleaksConfig, /useDefault = true/);
assert.match(gitleaksConfig, /targetRules = \["generic-api-key"\]/);
assert.match(gitleaksConfig, /condition = "AND"/);
assert.match(gitleaksConfig, /regexTarget = "line"/);
assert.match(gitleaksConfig, /\^monitoring\/\(\?:alertmanager\\\.go\\\.sum\|govulncheck\/go\\\.sum\)\$/);
const approvedActionReferences = new Set([
  'actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9',
  'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
  'actions/dependency-review-action@a1d282b36b6f3519aa1f3fc636f609c47dddb294',
  'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
  'actions/setup-python@83679a892e2d95755f2dac6acb0bfd1e9ac5d548',
  'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
  'aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25',
  'docker/setup-buildx-action@bb05f3f5519dd87d3ba754cc423b652a5edd6d2c',
  'github/codeql-action/analyze@5595ccaf912efad79be6eef63a5619ff05969be3',
  'github/codeql-action/init@5595ccaf912efad79be6eef63a5619ff05969be3',
  'gitleaks/gitleaks-action@e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e',
  'SonarSource/sonarqube-scan-action@22918119ff8e1ca75a623e15c8296b6ea4fbe28f',
]);
for (const reference of actionReferences) {
  assert.match(
    reference,
    /^[^@\s]+@[a-f0-9]{40}$/,
    `action reference must use a full SHA: ${reference}`
  );
  assert.ok(approvedActionReferences.has(reference), `action reference is not on the reviewed allowlist: ${reference}`);
}

const safeTrivyAction = 'aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25';
assert.equal(
  actionReferences.filter((reference) => reference === safeTrivyAction).length,
  10,
  'all Trivy steps must use the known-safe action commit'
);
assert.equal((workflow.match(/^\s*version:\s*v0\.70\.0\s*$/gm) ?? []).length, 10);
assert.equal(
  (workflow.match(/^\s*limit-severities-for-sarif:\s*true\s*$/gm) ?? []).length,
  5,
  'every blocking SARIF scan must apply the HIGH/CRITICAL severity limit'
);
assert.doesNotMatch(workflow, /^\s*version:\s*latest\s*$/m);
assert.doesNotMatch(
  workflow,
  /aquasecurity\/trivy-action@b6643a29fecd7f34b3597bc6acb0a98b03d33ff8/
);
assert.match(stagingWorkflow, /timeout-minutes:\s*30/);
assert.match(stagingWorkflow, /AI_GOLDEN_CASE_DELAY_MS:\s*'5000'/);
assert.match(stagingWorkflow, /run:\s*npm run test:ai-eval/);

assert.match(workflow, /shard:\s*\[queue, retry, schema, trading-risk\]/);
assert.match(workflow, /npm run test:mutation -- \$\{\{ matrix\.shard \}\}/);
assert.match(strykerConfig, /process\.env\.STRYKER_SHARD/);
assert.match(strykerConfig, /cleanTempDir:\s*'always'/);
assert.match(strykerConfig, /concurrency:\s*1/);
assert.match(mutationRunner, /timeout:\s*20 \* 60_000/);
assert.match(workflow, /cron:\s*'17 3 \* \* 1'/);
assert.match(
  workflow,
  /sast:[\s\S]*?permissions:[\s\S]*?actions:\s*read[\s\S]*?contents:\s*read/,
  'CodeQL needs workflow metadata and repository read access'
);
assert.match(workflow, /upload:\s*never/);
assert.ok(
  workflow.includes("jq --slurp --exit-status '[.[].runs[]?.results[]?] | length == 0' codeql-results/*.sarif")
);
assert.match(workflow, /name:\s*codeql-evidence-\$\{\{ github\.sha \}\}/);
assert.doesNotMatch(workflow, /ignore-unfixed:\s*true/);
assert.match(workflow, /retention-days:\s*90/);
assert.match(workflow, /project:\s*\[chromium, firefox, webkit, mobile-chromium\]/);
assert.match(workflow, /playwright install --with-deps/);
assert.match(workflow, /playwright test --project=\$\{\{ matrix\.project \}\}/);
assert.match(workflow, /github\.event\.repository\.private == false[\s\S]*?actions\/dependency-review-action@a1d282b36b6f3519aa1f3fc636f609c47dddb294/);
assert.match(workflow, /github\.event\.repository\.private[\s\S]*?npm audit --audit-level=moderate[\s\S]*?npm audit --prefix frontend --audit-level=moderate[\s\S]*?npm run quality:dependencies/);
assert.doesNotMatch(workflow, /^\s{2}release:\s*$/m);
assert.doesNotMatch(workflow, /create-github-app-token|gh release create|packages:\s*write/);

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
assert.equal(runtimeImage, 'gcr.io/distroless/nodejs22-debian13@sha256:bde4c459719d1101d0ed962bb1eec9cbf58bbbaca3560ac143c8ca02ab02e099');
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
assert.match(
  executorDockerfile,
  /^ARG PYTHON_IMAGE=python@sha256:31a768b01976652c222e318fe5bd6e7c252f056cbf489c88fa256f1bf0af58e3$/m,
);
assert.match(executorDockerfile, /apk add --no-cache "sqlite-libs=3\.53\.4-r0"/);
assert.match(executorDockerfile, /^USER 65532:65532$/m);
assert.match(executorDockerfile, /pip install --require-hashes/);
assert.match(executorLock, /^#\s+uv pip compile requirements\.in --universal --python-version 3\.12 --generate-hashes --output-file requirements\.lock$/m);
assert.match(executorLock, /^ccxt==4\.5\.75 \\/m);
assert.match(executorLock, /^uvloop==0\.22\.1 ; implementation_name == 'cpython' and sys_platform != 'win32' \\/m);
assert.match(executorLock, /^winloop==0\.6\.3 ; .*sys_platform == 'win32' \\/m);
assert.match(executorLock, /05815e6e7fdf8c8e28602150d7d6f8a9a98050dac3fc133ffff182444e4e6545/);
assert.match(executorLock, /5509c2659e4bfad6f4f5a9cea5c15ad244121263b423ae92f7ccbc4c04cfd8d9/);
assert.match(ccxtClient, /import ccxt\.async_support as ccxt_async/);
assert.match(ccxtClient, /import ccxt\.pro as ccxt_pro/);
assert.match(ccxtClient, /CERTIFIED_EXCHANGES = \{"hyperliquid", "bybit", "krakenfutures"\}/);
assert.match(ccxtClient, /"builderFee": False, "approvedBuilderFee": False/);
assert.match(ccxtAdapter, /clients\.rest\.create_orders/);
assert.match(ccxtAdapter, /clients\.rest\.fetch_positions/);
assert.match(streamHub, /clients\.pro\.watch_orders/);
assert.match(streamHub, /clients\.pro\.watch_my_trades/);
assert.match(streamHub, /clients\.pro\.watch_positions/);
const executorService = dockerCompose.slice(
  dockerCompose.indexOf('\n  exchange-executor:'),
  dockerCompose.indexOf('\n  mcp-server:'),
);
assert.ok(executorService.length > 0, 'compose must define the exchange executor service');
assert.doesNotMatch(executorService, /^\s+ports:/m);
const mcpService = dockerCompose.slice(
  dockerCompose.indexOf('\n  mcp-server:'),
  dockerCompose.indexOf('\nvolumes:'),
);
assert.doesNotMatch(mcpService, /profiles:/, 'MCP must start with the default stack and be gated by its runtime mode');
assert.match(mcpService, /condition:\s*service_healthy/);
assert.match(mcpService, /MCP_RUNTIME_POLL_MS:/);
assert.match(mcpService, /"127\.0\.0\.1:\$\{HOST_MCP_PORT:-8091\}:8091"/);
assert.match(dockerCompose, /forwarder_secrets:\/app\/secrets:ro/);

const alertmanagerGoImage = alertmanagerDockerfile.match(/^ARG GO_IMAGE=([^\s]+)$/m)?.[1];
const alertmanagerRuntimeImage = alertmanagerDockerfile.match(/^ARG RUNTIME_IMAGE=([^\s]+)$/m)?.[1];
assert.match(alertmanagerGoImage ?? '', /^golang:1\.26\.6-bookworm@sha256:[a-f0-9]{64}$/);
assert.match(alertmanagerRuntimeImage ?? '', /^gcr\.io\/distroless\/static-debian13:nonroot@sha256:[a-f0-9]{64}$/);
assert.match(alertmanagerDockerfile, /--checksum=sha256:[a-f0-9]{64}[\s\S]*?codeload\.github\.com\/prometheus\/alertmanager\/tar\.gz\/2c8da51e03f3dbbed24f9711ca2d76aab4eef9c5/);
assert.match(alertmanagerDockerfile, /github\.com\/prometheus\/common\/version\.BuildDate=20260704-19:05:41/);
assert.match(alertmanagerModuleLock, /github\.com\/klauspost\/compress v1\.18\.7/);
assert.match(alertmanagerModuleLock, /go\.opentelemetry\.io\/otel v1\.44\.0/);
assert.match(alertmanagerSumLock, /github\.com\/klauspost\/compress v1\.18\.7 h1:/);
assert.match(vulncheckModuleLock, /require golang\.org\/x\/vuln v1\.6\.0/);
assert.match(vulncheckSumLock, /golang\.org\/x\/vuln v1\.6\.0 h1:/);
assert.match(alertmanagerDockerfile, /GOFLAGS=-mod=readonly/);
assert.doesNotMatch(alertmanagerDockerfile, /\bgo (?:get|install)\b/);
assert.match(alertmanagerDockerfile, /^ARG SOURCE_DATE_EPOCH=1783191941$/m);
assert.match(alertmanagerDockerfile, /^FROM --platform=\$\{BUILDPLATFORM\} \$\{GO_IMAGE\} AS builder$/m);
assert.match(alertmanagerDockerfile, /find \/out\/rootfs -exec touch -h --date="@\$\{SOURCE_DATE_EPOCH\}"/);
assert.doesNotMatch(alertmanagerDockerfile, /-ldflags="[^"]*-s(?:\s|$)/);
assert.match(alertmanagerDockerfile, /govulncheck -scan=symbol \.\/cmd\/alertmanager \.\/cmd\/amtool/);
assert.equal((alertmanagerDockerfile.match(/govulncheck -mode=binary -scan=symbol/g) ?? []).length, 2);
assert.match(alertmanagerDockerfile, /^USER 65534:65534$/m);
assert.doesNotMatch(alertmanagerDockerfile, /^(?:COPY|ADD)\s+(?:--[^\s]+\s+)*\.\/?\s/m, 'Alertmanager build must not copy the workspace root.');
assert.match(monitoringCompose, /alertmanager:[\s\S]*?image:\s*\$\{ALERTMANAGER_IMAGE:-tsx-core-alertmanager:0\.33\.1-hardened\}[\s\S]*?dockerfile:\s*monitoring\/alertmanager\.Dockerfile/);
assert.match(workflow, /docker buildx build --provenance=false --platform linux\/amd64 --load --metadata-file alertmanager-amd64-build\.json --file monitoring\/alertmanager\.Dockerfile --tag tsx-core-alertmanager:\$\{\{ github\.sha \}\}-amd64 \./);
assert.match(workflow, /docker buildx build --provenance=false --platform linux\/arm64 --load --metadata-file alertmanager-arm64-build\.json --file monitoring\/alertmanager\.Dockerfile --tag tsx-core-alertmanager:\$\{\{ github\.sha \}\}-arm64 \./);
assert.equal((allWorkflows.match(/docker\/setup-buildx-action@bb05f3f5519dd87d3ba754cc423b652a5edd6d2c/g) ?? []).length, 1);
assert.equal((allWorkflows.match(/^\s*version:\s*v0\.36\.1\s*$/gm) ?? []).length, 1);
assert.equal((allWorkflows.match(/image=moby\/buildkit:v0\.32\.2@sha256:28a898719c18a33f4e8000685287fa36fd0dd9560c6440227d3a732d79bb41d8/g) ?? []).length, 1);
assert.match(workflow, /--no-cache --provenance=false --platform linux\/amd64 --load --metadata-file alertmanager-amd64-rebuild\.json/);
assert.equal((workflow.match(/--target security-audit --build-arg VULN_DB_EPOCH=\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/g) ?? []).length, 3);
assert.equal((workflow.match(/image-ref:\s*tsx-core-alertmanager:\$\{\{ github\.sha \}\}-amd64/g) ?? []).length, 2);
assert.equal((workflow.match(/image-ref:\s*tsx-core-alertmanager:\$\{\{ github\.sha \}\}-arm64/g) ?? []).length, 2);
assert.doesNotMatch(workflow, /TRIVY_VEX:[^\n]*alertmanager/);
const applicationVulnerabilityGate = workflow.slice(
  workflow.indexOf('- name: Block high and critical container vulnerabilities'),
  workflow.indexOf('- name: Generate exchange executor SBOM'),
);
assert.match(applicationVulnerabilityGate, /TRIVY_VEX:\s*security\/vex\/CVE-2026-14456\.openvex\.json/);
assert.match(applicationVulnerabilityGate, /TRIVY_SHOW_SUPPRESSED:\s*true/);
assert.equal(applicationVex['@context'], 'https://openvex.dev/ns/v0.2.0');
assert.equal(applicationVex.statements.length, 1);
assert.deepEqual(applicationVex.statements[0], {
  vulnerability: { name: 'CVE-2026-14456' },
  products: [{ '@id': 'pkg:deb/debian/libssl3t64@3.5.6-1~deb13u2' }],
  status: 'not_affected',
  justification: 'vulnerable_code_not_in_execute_path',
  impact_statement: 'TSX Core exposes no OpenSSL QUIC listener, QUIC socket, or HTTP/3 endpoint; inbound dashboard and MCP traffic uses TCP HTTP behind Tailscale Serve.',
});

const releaseImages = {
  FORWARDER_IMAGE: `ghcr.io/example/forwarder@sha256:${'a'.repeat(64)}`,
  EXCHANGE_EXECUTOR_IMAGE: `ghcr.io/example/exchange-executor@sha256:${'b'.repeat(64)}`,
  ALERTMANAGER_IMAGE: `ghcr.io/example/alertmanager@sha256:${'c'.repeat(64)}`,
};
assert.deepEqual(validateDeploymentImages(releaseImages), []);
assert.ok(validateDeploymentImages({ ...releaseImages, FORWARDER_IMAGE: 'forwarder:latest' }).length > 0);
assert.ok(validateDeploymentImages({}).length > 0);

console.log('Supply-chain pinning policy tests passed.');
