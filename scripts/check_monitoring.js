import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const monitoring = path.join(root, 'monitoring');
const dockerExecutable = process.platform === 'win32'
  ? String.raw`C:\Program Files\Docker\Docker\resources\bin\docker.exe`
  : '/usr/bin/docker';
const prometheusImage = 'tsx-core-prometheus:3.13.2-hardened';
const alertmanagerImage = 'tsx-core-alertmanager:0.33.1-hardened';
const prometheusDockerfile = path.join(root, 'monitoring', 'prometheus.Dockerfile');
const alertmanagerDockerfile = path.join(root, 'monitoring', 'alertmanager.Dockerfile');
const mount = `type=bind,source=${monitoring},target=/etc/prometheus,readonly`;

function build(image, dockerfile, label) {
  const result = spawnSync(dockerExecutable, [
    'build', '--provenance=false', '--file', dockerfile, '--tag', image, root,
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
  if (result.status !== 0) throw new Error(`Hardened ${label} build failed with exit code ${result.status}.`);
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
  build(prometheusImage, prometheusDockerfile, 'Prometheus');
  build(alertmanagerImage, alertmanagerDockerfile, 'Alertmanager');
  run(prometheusImage, '/usr/bin/promtool', ['check', 'config', 'prometheus.yml']);
  run(prometheusImage, '/usr/bin/promtool', ['test', 'rules', 'rules.test.yml']);
  run(alertmanagerImage, '/bin/amtool', ['check-config', '/etc/prometheus/alertmanager.yml']);
}
console.log('Monitoring configuration and alert rule tests passed.');
