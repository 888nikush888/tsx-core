import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const monitoring = path.join(root, 'monitoring');
const prometheusImage = 'prom/prometheus:v3.13.0-distroless@sha256:f3b6aae627d96e7ad8256cdf6de5953247735117c6f577383fadb42efeeea7bc';
const alertmanagerImage = 'prom/alertmanager:v0.32.1@sha256:51a825c2a40acc3e338fdd00d622e01ec090f72be2b3ea46be0839cd47a4d286';
const mount = `type=bind,source=${monitoring},target=/etc/prometheus,readonly`;

function run(image, entrypoint, args) {
  const result = spawnSync('docker', [
    'run', '--rm',
    '--mount', mount,
    '--workdir', '/etc/prometheus',
    '--entrypoint', entrypoint,
    image,
    ...args
  ], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    timeout: 120_000,
    windowsHide: true
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${entrypoint} ${args.join(' ')} failed with exit code ${result.status}.`);
}

function runLocal(executable, args) {
  const result = spawnSync(path.resolve(executable), args, {
    cwd: monitoring,
    encoding: 'utf8',
    shell: false,
    timeout: 120_000,
    windowsHide: true
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(executable)} ${args.join(' ')} failed with exit code ${result.status}.`);
}

if (process.env.PROMTOOL_PATH && process.env.AMTOOL_PATH) {
  runLocal(process.env.PROMTOOL_PATH, ['check', 'config', 'prometheus.yml']);
  runLocal(process.env.PROMTOOL_PATH, ['test', 'rules', 'rules.test.yml']);
  runLocal(process.env.AMTOOL_PATH, ['check-config', 'alertmanager.yml']);
} else {
  run(prometheusImage, '/bin/promtool', ['check', 'config', 'prometheus.yml']);
  run(prometheusImage, '/bin/promtool', ['test', 'rules', 'rules.test.yml']);
  run(alertmanagerImage, '/bin/amtool', ['check-config', '/etc/prometheus/alertmanager.yml']);
}
console.log('Monitoring configuration and alert rule tests passed.');
