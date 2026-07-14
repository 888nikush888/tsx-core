import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [prometheus, rules, alertmanager, compose, checker] = await Promise.all([
  readFile('monitoring/prometheus.yml', 'utf8'),
  readFile('monitoring/rules.yml', 'utf8'),
  readFile('monitoring/alertmanager.yml', 'utf8'),
  readFile('docker-compose.monitoring.yml', 'utf8'),
  readFile('scripts/check_monitoring.js', 'utf8')
]);

assert.match(prometheus, /alertmanager:9093/);
assert.match(prometheus, /forwarder:9100/);
for (const requiredAlert of [
  'ForwarderMetricsMissing',
  'ForwarderUnknownDelivery',
  'ForwarderBackupUnhealthy',
  'ForwarderDiskCapacityUnsafe',
  'ForwarderAuditTrailUnhealthy',
  'ForwarderDeliverySuccessSloBurn',
  'ForwarderDeliveryLatencySloBurn'
]) assert.match(rules, new RegExp(`alert: ${requiredAlert}`));
assert.match(alertmanager, /credentials_file:\s*\/run\/secrets\/alert_relay_token/);
assert.match(alertmanager, /send_resolved:\s*true/);
assert.match(compose, /prom\/prometheus:v3\.13\.0-distroless@sha256:[a-f0-9]{64}/);
assert.match(compose, /prom\/alertmanager:v0\.32\.1@sha256:[a-f0-9]{64}/);
assert.doesNotMatch(compose, /:latest(?:@|\s|$)/);
assert.match(compose, /127\.0\.0\.1:\$\{HOST_PROMETHEUS_PORT:-9090\}:9090/);
assert.match(checker, /promtool.*check/s);
assert.match(checker, /promtool.*test/s);
assert.match(checker, /amtool.*check-config/s);

console.log('Monitoring artifact policy tests passed.');
