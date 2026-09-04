import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const [
  prometheus, rules, alertmanager, compose, applicationCompose, checker, workflow,
  prometheusDockerfile, prometheusModuleLock, prometheusSumLock,
  alertmanagerDockerfile, alertmanagerModuleLock, alertmanagerSumLock,
  vulncheckModuleLock, vulncheckSumLock, vexFiles,
] = await Promise.all([
  readFile('monitoring/prometheus.yml', 'utf8'),
  readFile('monitoring/rules.yml', 'utf8'),
  readFile('monitoring/alertmanager.yml', 'utf8'),
  readFile('docker-compose.monitoring.yml', 'utf8'),
  readFile('docker-compose.yml', 'utf8'),
  readFile('scripts/check_monitoring.js', 'utf8'),
  readFile('.github/workflows/quality.yml', 'utf8'),
  readFile('monitoring/prometheus.Dockerfile', 'utf8'),
  readFile('monitoring/prometheus.go.mod', 'utf8'),
  readFile('monitoring/prometheus.go.sum', 'utf8'),
  readFile('monitoring/alertmanager.Dockerfile', 'utf8'),
  readFile('monitoring/alertmanager.go.mod', 'utf8'),
  readFile('monitoring/alertmanager.go.sum', 'utf8'),
  readFile('monitoring/govulncheck/go.mod', 'utf8'),
  readFile('monitoring/govulncheck/go.sum', 'utf8'),
  readdir('monitoring/vex'),
]);
const prometheusImage = 'tsx-core-prometheus:3.13.2-hardened';
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
assert.match(compose, /prometheus:[\s\S]*?build:[\s\S]*?dockerfile:\s*monitoring\/prometheus\.Dockerfile/);
assert.match(checker, /build\(prometheusImage, prometheusDockerfile, 'Prometheus'\)/);
assert.equal(workflow.split('image-ref: tsx-core-prometheus:${{ github.sha }}').length - 1, 2, 'SBOM and blocking scan must use the hardened image');
assert.match(workflow, /docker buildx build --provenance=false --platform linux\/amd64 --load --file "\$RUNNER_TEMP\/tsx-reviewed-source\/monitoring\/prometheus\.Dockerfile" --tag tsx-core-prometheus:\$\{\{ github\.sha \}\} "\$RUNNER_TEMP\/tsx-reviewed-source"/);
assert.ok(compose.includes(alertmanagerImage));
assert.match(compose, /alertmanager:[\s\S]*?build:[\s\S]*?dockerfile:\s*monitoring\/alertmanager\.Dockerfile/);
assert.ok(checker.includes(alertmanagerImage));
assert.match(checker, /build\(alertmanagerImage, alertmanagerDockerfile, 'Alertmanager'\)/);
assert.match(checker, /'build', '--provenance=false', '--file', dockerfile, '--tag', image, root/);
assert.equal(workflow.split('image-ref: tsx-core-alertmanager:${{ github.sha }}-amd64').length - 1, 2);
assert.equal(workflow.split('image-ref: tsx-core-alertmanager:${{ github.sha }}-arm64').length - 1, 2);
assert.match(workflow, /docker buildx build --provenance=false --platform linux\/amd64 --load --metadata-file alertmanager-amd64-build\.json --file "\$RUNNER_TEMP\/tsx-reviewed-source\/monitoring\/alertmanager\.Dockerfile" --tag tsx-core-alertmanager:\$\{\{ github\.sha \}\}-amd64 "\$RUNNER_TEMP\/tsx-reviewed-source"/);
assert.match(workflow, /docker buildx build --provenance=false --platform linux\/arm64 --load --metadata-file alertmanager-arm64-build\.json --file "\$RUNNER_TEMP\/tsx-reviewed-source\/monitoring\/alertmanager\.Dockerfile" --tag tsx-core-alertmanager:\$\{\{ github\.sha \}\}-arm64 "\$RUNNER_TEMP\/tsx-reviewed-source"/);
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

assert.match(prometheusDockerfile, /^ARG GO_IMAGE=golang:1\.26\.6-bookworm@sha256:116d58cbd88c1297624acc6e967a060012422bacf9930927e23fb719189c6f36$/m);
assert.match(prometheusDockerfile, /^ARG RUNTIME_IMAGE=gcr\.io\/distroless\/static-debian13:nonroot@sha256:f7f8f729987ad0fdf6b05eeeae94b26e6a0f613bdf46feea7fc40f7bd72953e6$/m);
assert.match(prometheusDockerfile, /ADD --checksum=sha256:beffc32fe1e56dd49c2146589e63182414c5fea1cc555343d29d58a7ee49332d[\s\S]*?bb5dff00cf8fdfbf5c65e0531aa835fa238a43a2/);
assert.match(prometheusDockerfile, /ADD --checksum=sha256:6a2255eb51cbe8735a58b4955d3b211920e91331590654bf81b1c1d4a4b32e9d[\s\S]*?prometheus-web-ui-3\.13\.2\.tar\.gz/);
assert.match(prometheusDockerfile, /PREBUILT_ASSETS_STATIC_DIR=web\/ui\/static make assets-compress/);
assert.match(prometheusDockerfile, /-trimpath -buildvcs=false -tags=netgo,builtinassets/);
assert.match(prometheusDockerfile, /-o \/out\/rootfs\/usr\/bin\/prometheus \.\/cmd\/prometheus/);
assert.match(prometheusDockerfile, /-o \/out\/rootfs\/usr\/bin\/promtool \.\/cmd\/promtool/);
assert.match(prometheusDockerfile, /GOFLAGS=-mod=readonly/);
assert.match(prometheusDockerfile, /COPY --chmod=0444 monitoring\/prometheus\.go\.mod monitoring\/prometheus\.go\.sum/);
assert.doesNotMatch(prometheusDockerfile, /\bgo (?:get|install)\b/);
assert.match(prometheusModuleLock, /golang\.org\/x\/crypto v0\.55\.0/);
assert.match(prometheusSumLock, /golang\.org\/x\/crypto v0\.55\.0 h1:/);
assert.match(prometheusDockerfile, /test "\$\(go list -m -f '\{\{\.Version\}\}' golang\.org\/x\/crypto\)" = "v0\.55\.0"/);
assert.match(prometheusModuleLock, /google\.golang\.org\/grpc v1\.83\.1/);
assert.match(prometheusSumLock, /google\.golang\.org\/grpc v1\.83\.1 h1:/);
assert.match(prometheusDockerfile, /test "\$\(go list -m -f '\{\{\.Version\}\}' google\.golang\.org\/grpc\)" = "v1\.83\.1"/);
assert.match(prometheusDockerfile, /COPY --chmod=0444 monitoring\/govulncheck\/go\.mod monitoring\/govulncheck\/go\.sum/);
assert.doesNotMatch(prometheusDockerfile, /\bgo install\b/);
assert.match(prometheusDockerfile, /^FROM builder AS security-audit$/m);
assert.equal((prometheusDockerfile.match(/govulncheck -mode=binary -scan=symbol/g) ?? []).length, 2);
assert.match(prometheusDockerfile, /^USER 65534:65534$/m);
const prometheusRuntime = prometheusDockerfile.slice(prometheusDockerfile.indexOf('FROM ${RUNTIME_IMAGE} AS runner'));
assert.doesNotMatch(prometheusRuntime, /^RUN\s/m, 'Hardened Prometheus runtime must not install packages.');

assert.match(alertmanagerDockerfile, /^ARG GO_IMAGE=golang:1\.26\.6-bookworm@sha256:116d58cbd88c1297624acc6e967a060012422bacf9930927e23fb719189c6f36$/m);
assert.match(alertmanagerDockerfile, /^ARG RUNTIME_IMAGE=gcr\.io\/distroless\/static-debian13:nonroot@sha256:f7f8f729987ad0fdf6b05eeeae94b26e6a0f613bdf46feea7fc40f7bd72953e6$/m);
assert.match(alertmanagerDockerfile, /ADD --checksum=sha256:fdeab39769b39ebeb2fa0da244295dfb02da76e1c8b5afc041fbd99076ed5181[\s\S]*?2c8da51e03f3dbbed24f9711ca2d76aab4eef9c5/);
assert.match(alertmanagerDockerfile, /ADD --checksum=sha256:1f63344e196e47ba7bfe27276f44c1da77e39fb76493e42b2cf0a50ca8f04321[\s\S]*?alertmanager-web-ui-0\.33\.1\.tar\.gz/);
for (const dependency of [
  'golang.org/x/text v0.41.0',
  'golang.org/x/mod v0.40.0',
  'google.golang.org/grpc v1.83.1',
  'golang.org/x/crypto v0.55.0',
  'github.com/klauspost/compress v1.18.7',
  'go.opentelemetry.io/otel v1.44.0',
  'go.opentelemetry.io/otel/metric v1.44.0',
  'go.opentelemetry.io/otel/trace v1.44.0',
]) assert.ok(alertmanagerModuleLock.includes(dependency));
assert.match(alertmanagerDockerfile, /COPY --chmod=0444 monitoring\/alertmanager\.go\.mod monitoring\/alertmanager\.go\.sum/);
assert.match(alertmanagerDockerfile, /GOFLAGS=-mod=readonly/);
assert.doesNotMatch(alertmanagerDockerfile, /\bgo (?:get|install)\b/);
assert.match(alertmanagerSumLock, /golang\.org\/x\/text v0\.41\.0 h1:/);
assert.match(vulncheckModuleLock, /require golang\.org\/x\/vuln v1\.6\.0/);
assert.match(vulncheckSumLock, /golang\.org\/x\/vuln v1\.6\.0 h1:/);
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
