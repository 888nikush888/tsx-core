import type { UiParameter } from './ui_contracts.js';
export type { UiParameter } from './ui_contracts.js';

export type FieldSpec = [path: string, type: string, constraints: string, unit?: string, emptyMeaning?: string];
export interface ParameterFamily {
  prefix: string; source: string; scope: string; effect: string; href: string; validator: string; consumer: string;
  requiresRestart?: boolean; editable?: boolean; secret?: boolean;
}
function defaultAt(value: unknown, key: string): { value: unknown; present: boolean } {
  let current: unknown = value;
  for (const part of key.split('.')) {
    if (typeof current !== 'object' || current === null || !Object.hasOwn(current, part)) return { value: null, present: false };
    current = (current as Record<string, unknown>)[part];
  }
  return { value: current, present: true };
}
export function parameterFields(family: ParameterFamily, fields: FieldSpec[], defaults?: unknown): UiParameter[] {
  return fields.map(([path, type, constraints, unit = null, emptyMeaning = 'Leer ist kein Ersatz für 0, false oder null; der konkrete Validator entscheidet.']) => {
    const fallback = defaultAt(defaults, path);
    return { ...family, path: `${family.prefix}.${path}`, type, unit, constraints, default: fallback.value,
      defaultPresent: fallback.present, nullable: type.includes('null'), emptyMeaning,
      requiresRestart: family.requiresRestart === true, editable: family.editable !== false, secret: family.secret === true };
  });
}
export function parameterLeaves(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length) return [prefix];
  return Object.entries(value).flatMap(([key, item]) => parameterLeaves(item, prefix ? `${prefix}.${key}` : key));
}
