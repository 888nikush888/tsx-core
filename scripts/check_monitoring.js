import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const monitoring = path.join(root, 'monitoring');
const dockerExecutable = process.platform === 'win32'
  ? String.raw`C:\Program Files\Docker\Docker\resources\bin\docker.exe`
  : '/usr/bin/docker';
const prometheusImage = 'prom/prometheus:v3.13.2-distroless@sha256:64f71bb84e03c855948418b0fc5dea53e9543d8e3fc9931598f583805507f05e';
const alertmanagerImage = 'tsx-core-alertmanager:0.33.1-hardened';
const alertmanagerDockerfile = path.join(root, 'monitoring', 'alertmanager.Dockerfile');
const mount = `type=bind,source=${monitoring},target=/etc/prometheus,readonly`;

function buildAlertmanager() {
  const result = spawnSync(dockerExecutable, [
    'build', '--provenance=false', '--file', alertmanagerDockerfile, '--tag', alertmanagerImage, root,
  ], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    timeout: 600_000,
    windowsHide: true,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Hardened Alertmanager build failed with exit code ${result.status}.`);
}

function run(image, entrypoint, args) {
  const result = spawnSync(dockerExecutable, [
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
  buildAlertmanager();
  run(prometheusImage, '/bin/promtool', ['check', 'config', 'prometheus.yml']);
  run(prometheusImage, '/bin/promtool', ['test', 'rules', 'rules.test.yml']);
  run(alertmanagerImage, '/bin/amtool', ['check-config', '/etc/prometheus/alertmanager.yml']);
}
console.log('Monitoring configuration and alert rule tests passed.');
