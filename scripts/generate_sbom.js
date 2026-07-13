import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = path.join(root, 'reports', 'sbom');
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('npm_execpath is required; run this script through npm.');

async function generate(name, workingDirectory) {
  const result = spawnSync(
    process.execPath,
    [npmCli, 'sbom', '--sbom-format', 'cyclonedx', '--omit', 'dev'],
    {
      cwd: workingDirectory,
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
      shell: false,
      windowsHide: true,
    }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `${name} SBOM generation failed.`);
  const sbom = JSON.parse(result.stdout);
  if (sbom.bomFormat !== 'CycloneDX' || !Array.isArray(sbom.components)) {
    throw new Error(`${name} SBOM is not a valid CycloneDX document.`);
  }
  const destination = path.join(outputDirectory, `${name}.cdx.json`);
  await writeFile(destination, `${JSON.stringify(sbom, null, 2)}\n`, 'utf8');
  console.log(`${name} CycloneDX SBOM generated (${sbom.components.length} components).`);
}

await mkdir(outputDirectory, { recursive: true });
await generate('backend', root);
await generate('frontend', path.join(root, 'frontend'));
