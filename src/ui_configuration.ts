import { createHash } from 'node:crypto';

export function configurationRevision(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

type ConfigurationObject = Record<string, unknown>;

function assertMergeableKey(key: string): void {
  if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Unsafe configuration key.');
}

function mergedBase(base: unknown): ConfigurationObject {
  return base !== null && typeof base === 'object' && !Array.isArray(base)
    ? structuredClone(base as ConfigurationObject)
    : {};
}

/** Object patches retain unedited siblings. Arrays are explicit replacements. */
export function mergeConfiguration(base: unknown, patch: unknown, depth = 0): unknown {
  assertMergeDepth(depth);
  if (isAtomicPatch(patch)) return structuredClone(patch);
  const merged = mergedBase(base);
  applyPatchEntries(merged, patch as ConfigurationObject, depth);
  return merged;
}

function assertMergeDepth(depth: number): void {
  if (depth > 16) throw new Error('Configuration exceeds the nesting limit.');
}

function isAtomicPatch(patch: unknown): boolean {
  return patch === null || typeof patch !== 'object' || Array.isArray(patch);
}

function applyPatchEntries(merged: ConfigurationObject, patch: ConfigurationObject, depth: number): void {
  for (const [key, value] of Object.entries(patch)) {
    assertMergeableKey(key);
    merged[key] = mergeConfiguration(merged[key], value, depth + 1);
  }
}
