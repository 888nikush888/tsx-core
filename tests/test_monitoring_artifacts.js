import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const [prometheus, rules, alertmanager, compose, applicationCompose, checker, workflow, alertmanagerDockerfile, vexFiles] = await Promise.all([
  readFile('monitoring/prometheus.yml', 'utf8'),
  readFile('monitoring/rules.yml', 'utf8'),
  readFile('monitoring/alertmanager.yml', 'utf8'),
  readFile('docker-compose.monitoring.yml', 'utf8'),
  readFile('docker-compose.yml', 'utf8'),
  readFile('scripts/check_monitoring.js', 'utf8'),
  readFile('.github/workflows/quality.yml', 'utf8'),
  readFile('monitoring/alertmanager.Dockerfile', 'utf8'),
  readdir('monitoring/vex'),
]);
const prometheusImage = 'prom/prometheus:v3.13.2-distroless@sha256:64f71bb84e03c855948418b0fc5dea53e9543d8e3fc9931598f583805507f05e';
const alertmanagerImage = 'tsx-core-alertmanager:0.33.1-hardened';

assert.match(prometheus, /alertmanager:9093/);
assert.match(prometheus, /forwarder:9100/);
for (const requiredAlert of [
  'ForwarderMetricsMissing',
  'ForwarderUnknownDelivery',
  'ForwarderBackupUnhealthy',
  'ForwarderDiskCapacityUnsafe',
  'ForwarderAuditTrailUnhealthy',
  'ForwarderClockDriftUnsafe',
  'ForwarderDeliverySuccessSloBurn',
  'ForwarderDeliveryLatencySloBurn',
  'ForwarderPendingTaskStale',
  'TradingUnknownOrder',
  'TradingUnprotectedPosition',
  'TradingKillSwitchActive',
  'TradingReconciliationStale'
]) assert.match(rules, new RegExp(`alert: ${requiredAlert}`));
assert.match(alertmanager, /credentials_file:\s*\/app\/secrets\/alert_relay_token/);
assert.match(alertmanager, /send_resolved:\s*true/);
assert.ok(compose.includes(prometheusImage));
assert.ok(checker.includes(prometheusImage));
assert.equal(workflow.split(prometheusImage).length - 1, 2, 'SBOM and blocking scan must use the release image');
assert.ok(compose.includes(alertmanagerImage));
assert.match(compose, /alertmanager:[\s\S]*?build:[\s\S]*?dockerfile:\s*monitoring\/alertmanager\.Dockerfile/);
assert.ok(checker.includes(alertmanagerImage));
assert.match(checker, /dockerExecutable[\s\S]*?'build'[\s\S]*?alertmanagerDockerfile[\s\S]*?'--tag'[\s\S]*?alertmanagerImage/);
assert.equal(workflow.split('image-ref: tsx-core-alertmanager:${{ github.sha }}-amd64').length - 1, 2);
assert.equal(workflow.split('image-ref: tsx-core-alertmanager:${{ github.sha }}-arm64').length - 1, 2);
assert.match(workflow, /docker buildx build --provenance=false --platform linux\/amd64 --load --metadata-file alertmanager-amd64-build\.json --file monitoring\/alertmanager\.Dockerfile --tag tsx-core-alertmanager:\$\{\{ github\.sha \}\}-amd64 \./);
assert.match(workflow, /docker buildx build --provenance=false --platform linux\/arm64 --load --metadata-file alertmanager-arm64-build\.json --file monitoring\/alertmanager\.Dockerfile --tag tsx-core-alertmanager:\$\{\{ github\.sha \}\}-arm64 \./);
assert.match(workflow, /docker buildx build --no-cache --provenance=false --platform linux\/amd64 --load --metadata-file alertmanager-amd64-rebuild\.json/);
assert.match(workflow, /containerimage\.digest[\s\S]*?alertmanager-amd64-build\.json[\s\S]*?containerimage\.digest[\s\S]*?alertmanager-amd64-rebuild\.json/);
assert.doesNotMatch(workflow, /TRIVY_VEX:[^\n]*alertmanager/);
assert.doesNotMatch(workflow, /image-ref:\s*prom\/alertmanager/);
assert.doesNotMatch(compose, /:latest(?:@|\s|$)/);
assert.match(applicationCompose, /image:\s*\$\{FORWARDER_IMAGE:-tsx-core:local\}/);
assert.match(compose, /image:\s*\$\{FORWARDER_IMAGE:-tsx-core:local\}/);
assert.match(compose, /alert-relay:[\s\S]*?command:\s*\[dist\/alert_relay\.js\]/);
assert.doesNotMatch(compose, /command:\s*\[node,\s*dist\/alert_relay\.js\]/);
assert.doesNotMatch(compose, /^\s*env_file:/m);
assert.match(compose, /ALERT_RELAY_TOKEN_FILE:\s*\/app\/secrets\/alert_relay_token/);
assert.match(compose, /RUNTIME_SETTINGS_PATH:\s*\/app\/config\/runtime-settings\.json/);
assert.match(compose, /127\.0\.0\.1:\$\{HOST_PROMETHEUS_PORT:-9090\}:9090/);
assert.match(checker, /promtool.*check/s);
assert.match(checker, /promtool.*test/s);
assert.match(checker, /amtool.*check-config/s);
assert.doesNotMatch(workflow, /TRIVY_VEX:\s*monitoring\/vex\/prometheus-/);
assert.deepEqual(vexFiles.filter(file => file.endsWith('.json')), [], 'Monitoring release images must pass without VEX exceptions.');

assert.match(alertmanagerDockerfile, /^ARG GO_IMAGE=golang:1\.26\.5-bookworm@sha256:6c5605ab3a9a9fb3c4eafe5b3d63cdbf3881caf113262b67862547b54a9db599$/m);
assert.match(alertmanagerDockerfile, /^ARG RUNTIME_IMAGE=gcr\.io\/distroless\/static-debian13:nonroot@sha256:f7f8f729987ad0fdf6b05eeeae94b26e6a0f613bdf46feea7fc40f7bd72953e6$/m);
assert.match(alertmanagerDockerfile, /ADD --checksum=sha256:fdeab39769b39ebeb2fa0da244295dfb02da76e1c8b5afc041fbd99076ed5181[\s\S]*?2c8da51e03f3dbbed24f9711ca2d76aab4eef9c5/);
assert.match(alertmanagerDockerfile, /ADD --checksum=sha256:1f63344e196e47ba7bfe27276f44c1da77e39fb76493e42b2cf0a50ca8f04321[\s\S]*?alertmanager-web-ui-0\.33\.1\.tar\.gz/);
for (const dependency of [
  'golang.org/x/text@v0.39.0',
  'google.golang.org/grpc@v1.82.1',
  'golang.org/x/crypto@v0.53.0',
  'github.com/klauspost/compress@v1.18.7',
  'go.opentelemetry.io/otel@v1.44.0',
  'go.opentelemetry.io/otel/metric@v1.44.0',
  'go.opentelemetry.io/otel/trace@v1.44.0',
]) assert.ok(alertmanagerDockerfile.includes(dependency));
assert.match(alertmanagerDockerfile, /CGO_ENABLED=0/);
assert.match(alertmanagerDockerfile, /^ARG SOURCE_DATE_EPOCH=1783191941$/m);
assert.match(alertmanagerDockerfile, /^FROM --platform=\$\{BUILDPLATFORM\} \$\{GO_IMAGE\} AS builder$/m);
assert.match(alertmanagerDockerfile, /-trimpath -buildvcs=false -tags=netgo/);
assert.match(alertmanagerDockerfile, /grep -E '\^golang\.org\/x\/crypto\/openpgp\(\/\|\$\)'/);
assert.match(alertmanagerDockerfile, /find \/out\/rootfs -exec touch -h --date="@\$\{SOURCE_DATE_EPOCH\}"/);
assert.match(alertmanagerDockerfile, /-o \/out\/rootfs\/usr\/bin\/alertmanager \.\/cmd\/alertmanager/);
assert.match(alertmanagerDockerfile, /-o \/out\/rootfs\/usr\/bin\/amtool \.\/cmd\/amtool/);
assert.doesNotMatch(alertmanagerDockerfile, /-ldflags="[^"]*-s(?:\s|$)/);
assert.match(alertmanagerDockerfile, /^FROM builder AS security-audit$/m);
assert.equal((alertmanagerDockerfile.match(/govulncheck -mode=binary -scan=symbol/g) ?? []).length, 2);
assert.match(alertmanagerDockerfile, /^USER 65534:65534$/m);
const alertmanagerRuntime = alertmanagerDockerfile.slice(alertmanagerDockerfile.indexOf('FROM ${RUNTIME_IMAGE} AS runner'));
assert.doesNotMatch(alertmanagerRuntime, /^RUN\s/m, 'Hardened Alertmanager runtime must not install packages.');

console.log('Monitoring artifact policy tests passed.');
