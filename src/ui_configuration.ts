import { createHash } from 'node:crypto';

export function configurationRevision(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Object patches retain unedited siblings. Arrays are explicit replacements. */
export function mergeConfiguration(base: any, patch: any, depth = 0): any {
  if (depth > 16) throw new Error('Configuration exceeds the nesting limit.');
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return structuredClone(patch);
  const merged = base && typeof base === 'object' && !Array.isArray(base) ? structuredClone(base) : {};
  for (const [key, value] of Object.entries(patch)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Unsafe configuration key.');
    merged[key] = mergeConfiguration(merged[key], value, depth + 1);
  }
  return merged;
}
