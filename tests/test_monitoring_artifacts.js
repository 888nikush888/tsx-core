import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [prometheus, rules, alertmanager, compose, applicationCompose, checker, workflow, alertmanagerVex] = await Promise.all([
  readFile('monitoring/prometheus.yml', 'utf8'),
  readFile('monitoring/rules.yml', 'utf8'),
  readFile('monitoring/alertmanager.yml', 'utf8'),
  readFile('docker-compose.monitoring.yml', 'utf8'),
  readFile('docker-compose.yml', 'utf8'),
  readFile('scripts/check_monitoring.js', 'utf8'),
  readFile('.github/workflows/quality.yml', 'utf8'),
  readFile('monitoring/vex/alertmanager-v0.33.1.openvex.json', 'utf8').then(JSON.parse)
]);
const prometheusImage = 'prom/prometheus:v3.13.2-distroless@sha256:64f71bb84e03c855948418b0fc5dea53e9543d8e3fc9931598f583805507f05e';

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
assert.match(compose, /prom\/alertmanager:v0\.33\.1@sha256:9e082985f56f4c8c9f724e18f2288c6708f472e56a5286b8863d080434ea065d/);
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
assert.match(workflow, /TRIVY_VEX:\s*monitoring\/vex\/alertmanager-v0\.33\.1\.openvex\.json/);

for (const [document, expectedProduct, expectedVulnerabilities] of [
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
