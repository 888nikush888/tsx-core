import type { WorkflowExecutionPath, WorkflowResourceVersion, TradingStrategyVersion } from './trading_types.js';

function isExpandableObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
}

function leaves(value: unknown, prefix = '', result: Array<[string, unknown]> = []): Array<[string, unknown]> {
  if (isExpandableObject(value)) {
    Object.entries(value).forEach(([key, item]) => leaves(item, prefix ? `${prefix}.${key}` : key, result));
  } else result.push([prefix, value]);
  return result;
}
function at(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((item, key) => item != null && typeof item === 'object' ? (item as Record<string, unknown>)[key] : undefined, value);
}
const UNIT_SUFFIXES: ReadonlyArray<[string, string]> = [
  ['Percent', '%'], ['Leverage', '×'], ['Seconds', 's'],
  ['maxPositionNotional', 'Quote-Währung des Markts; Auflösung im Tradeplan'],
  ['maxDailyLoss', 'abhängig von safety.maxDailyLossMode'],
];
function unit(path: string): string | null {
  return UNIT_SUFFIXES.find(([suffix]) => path.endsWith(suffix))?.[1] ?? null;
}
type SizingOrigin = { source: string; sourceVersionId: string | null; resourceId: string | null; overridesStrategy: boolean };
function schemaVersionOrigin(): SizingOrigin {
  return { source: 'Workflowcompiler', sourceVersionId: null, resourceId: null, overridesStrategy: false };
}
function strategyOrigin(strategy: TradingStrategyVersion | null): SizingOrigin {
  return { source: 'Gepinnte Strategie; bei Kompilierung validiert', sourceVersionId: strategy?.id ?? null, resourceId: null, overridesStrategy: false };
}
function sizingOrigin(sizing: WorkflowResourceVersion | null, key: string): SizingOrigin {
  return { source: sizing !== null && Object.hasOwn(sizing.configuration, key) ? 'Positionsgrößen-Baustein' : 'Standard der Positionsgrößen-Validierung',
    sourceVersionId: sizing?.id ?? null, resourceId: sizing?.resourceId ?? null, overridesStrategy: true };
}
function sizingKey(field: string, normalizedSizing: Record<string, unknown> | null | undefined): string | null {
  if (!field.startsWith('sizing.') || normalizedSizing == null) return null;
  const key = field.slice('sizing.'.length);
  return Object.hasOwn(normalizedSizing, key) ? key : null;
}
function parameterOrigin(field: string, normalizedSizing: Record<string, unknown> | null | undefined, sizing: WorkflowResourceVersion | null, strategy: TradingStrategyVersion | null) {
  if (field === 'schemaVersion') return schemaVersionOrigin();
  const key = sizingKey(field, normalizedSizing);
  if (key === null) return strategyOrigin(strategy);
  return sizingOrigin(sizing, key);
}
/** Explains the existing compiler's sizing override; never recalculates or authorizes a trade. */
export function uiEffectiveParameters(path: WorkflowExecutionPath, strategy: TradingStrategyVersion | null, sizing: WorkflowResourceVersion | null) {
  const effective = path.effectiveConfiguration.strategyConfiguration;
  const normalizedSizing = (path.effectiveConfiguration.resources as Record<string, unknown> | undefined)?.sizing as Record<string, unknown> | undefined;
  return leaves(effective).map(([field, value]) => {
    return { field, value, unit: unit(field), strategyValue: at(strategy?.configuration, field) ?? null,
      strategyValuePresent: at(strategy?.configuration, field) !== undefined,
      ...parameterOrigin(field, normalizedSizing, sizing, strategy), scope: `Revision ${path.workflowRevisionId} · Kanal ${path.channelId} · Konto ${path.accountId}`,
      effect: 'Kompilierter Ausgangswert für Intents dieses Pfads. Signal, adaptive Stufe und Markt-/FX-/Sicherheitsbelege werden im eigenen Tradeplan zusätzlich geprüft.' };
  });
}
