import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Matches the parser's actual source; relocating config.json never relocates templates implicitly. */
export function signalTemplatesDirectoryFromEnvironment(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.TEMPLATES_DIR?.trim() || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates'));
}
