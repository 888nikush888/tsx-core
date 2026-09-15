import { copyFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// TypeScript emits declarations for .ts sources but does not copy input .d.ts
// files. Preserve those contracts alongside the emitted declaration imports.
export async function copyDeclarations(source, destination) {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const input = path.join(source, entry.name);
    const output = path.join(destination, entry.name);
    if (entry.isDirectory()) await copyDeclarations(input, output);
    else if (entry.isFile() && entry.name.endsWith('.d.ts')) {
      await mkdir(destination, { recursive: true });
      await copyFile(input, output);
    }
  }
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  await copyDeclarations(path.join(root, 'src'), path.join(root, 'dist'));
}
