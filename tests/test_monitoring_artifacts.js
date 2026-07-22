import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [prometheus, rules, alertmanager, compose, applicationCompose, checker, workflow, prometheusVex, alertmanagerVex] = await Promise.all([
  readFile('monitoring/prometheus.yml', 'utf8'),
  readFile('monitoring/rules.yml', 'utf8'),
  readFile('monitoring/alertmanager.yml', 'utf8'),
  readFile('docker-compose.monitoring.yml', 'utf8'),
  readFile('docker-compose.yml', 'utf8'),
  readFile('scripts/check_monitoring.js', 'utf8'),
  readFile('.github/workflows/quality.yml', 'utf8'),
  readFile('monitoring/vex/prometheus-v3.13.1.openvex.json', 'utf8').then(JSON.parse),
  readFile('monitoring/vex/alertmanager-v0.33.1.openvex.json', 'utf8').then(JSON.parse)
]);

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
  'ForwarderPendingTaskStale'
]) assert.match(rules, new RegExp(`alert: ${requiredAlert}`));
assert.match(alertmanager, /credentials_file:\s*\/app\/secrets\/alert_relay_token/);
assert.match(alertmanager, /send_resolved:\s*true/);
assert.match(compose, /prom\/prometheus:v3\.13\.1-distroless@sha256:214f8427c8fba80c327bb94a75feb802ae12f2d6ca30812aa6e7d22f09bbea80/);
assert.match(compose, /prom\/alertmanager:v0\.33\.1@sha256:9e082985f56f4c8c9f724e18f2288c6708f472e56a5286b8863d080434ea065d/);
assert.doesNotMatch(compose, /:latest(?:@|\s|$)/);
assert.match(applicationCompose, /image:\s*\$\{FORWARDER_IMAGE:-telegram-tdlib-forwarder:local\}/);
assert.match(compose, /image:\s*\$\{FORWARDER_IMAGE:-telegram-tdlib-forwarder:local\}/);
assert.match(compose, /alert-relay:[\s\S]*?command:\s*\[dist\/alert_relay\.js\]/);
assert.doesNotMatch(compose, /command:\s*\[node,\s*dist\/alert_relay\.js\]/);
assert.doesNotMatch(compose, /^\s*env_file:/m);
assert.match(compose, /ALERT_RELAY_TOKEN_FILE:\s*\/app\/secrets\/alert_relay_token/);
assert.match(compose, /RUNTIME_SETTINGS_PATH:\s*\/app\/config\/runtime-settings\.json/);
assert.match(compose, /127\.0\.0\.1:\$\{HOST_PROMETHEUS_PORT:-9090\}:9090/);
assert.match(checker, /promtool.*check/s);
assert.match(checker, /promtool.*test/s);
assert.match(checker, /amtool.*check-config/s);
assert.match(workflow, /TRIVY_VEX:\s*monitoring\/vex\/prometheus-v3\.13\.1\.openvex\.json/);
assert.match(workflow, /TRIVY_VEX:\s*monitoring\/vex\/alertmanager-v0\.33\.1\.openvex\.json/);

for (const [document, expectedProduct, expectedVulnerabilities] of [
  [prometheusVex, 'pkg:golang/google.golang.org/grpc@v1.81.1', ['GHSA-hrxh-6v49-42gf']],
  [alertmanagerVex, null, [
    'CVE-2026-39822', 'CVE-2026-39828', 'CVE-2026-39829', 'CVE-2026-39830',
    'CVE-2026-39831', 'CVE-2026-39832', 'CVE-2026-39835', 'CVE-2026-42508',
    'CVE-2026-46595', 'CVE-2026-46597', 'GHSA-hrxh-6v49-42gf'
  ]]
]) {
  assert.equal(document['@context'], 'https://openvex.dev/ns/v0.2.0');
  assert.deepEqual(document.statements.map(statement => statement.vulnerability.name).sort(), [...expectedVulnerabilities].sort());
  for (const statement of document.statements) {
    assert.equal(statement.status, 'not_affected');
    assert.equal(statement.justification, 'vulnerable_code_not_in_execute_path');
    assert.ok(statement.impact_statement.length >= 40);
    assert.ok(statement.action_statement.length >= 40);
    assert.equal(statement.products.length, 1);
    assert.match(statement.products[0]['@id'], /^pkg:golang\/.+@v\d/);
  }
  if (expectedProduct) assert.equal(document.statements[0].products[0]['@id'], expectedProduct);
}

console.log('Monitoring artifact policy tests passed.');
