import type { WorkflowExecutionPath, WorkflowResourceVersion, TradingStrategyVersion } from './trading_types.js';

function leaves(value: unknown, prefix = '', result: Array<[string, unknown]> = []): Array<[string, unknown]> {
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length) {
    Object.entries(value).forEach(([key, item]) => leaves(item, prefix ? `${prefix}.${key}` : key, result));
  } else result.push([prefix, value]);
  return result;
}
function at(value: unknown, path: string): unknown {
  return path.split('.').reduce<any>((item, key) => item != null && typeof item === 'object' ? item[key] : undefined, value);
}
function unit(path: string): string | null {
  if (/Percent$/.test(path)) return '%';
  if (/Leverage$/.test(path)) return '×';
  if (/Seconds$/.test(path)) return 's';
  if (/maxPositionNotional$/.test(path)) return 'Quote-Währung des Markts; Auflösung im Tradeplan';
  if (/maxDailyLoss$/.test(path)) return 'abhängig von safety.maxDailyLossMode';
  return null;
}
function parameterOrigin(field: string, normalizedSizing: any, sizing: WorkflowResourceVersion | null, strategy: TradingStrategyVersion | null) {
  if (field === 'schemaVersion') return { source: 'Workflowcompiler', sourceVersionId: null, resourceId: null, overridesStrategy: false };
  const key = field.startsWith('sizing.') ? field.slice('sizing.'.length) : null;
  const override = key !== null && normalizedSizing != null && Object.hasOwn(normalizedSizing, key);
  if (!override) return { source: 'Gepinnte Strategie; bei Kompilierung validiert', sourceVersionId: strategy?.id ?? null, resourceId: null, overridesStrategy: false };
  return { source: sizing && Object.hasOwn(sizing.configuration, key!) ? 'Positionsgrößen-Baustein' : 'Standard der Positionsgrößen-Validierung',
    sourceVersionId: sizing?.id ?? null, resourceId: sizing?.resourceId ?? null, overridesStrategy: true };
}
/** Explains the existing compiler's sizing override; never recalculates or authorizes a trade. */
export function uiEffectiveParameters(path: WorkflowExecutionPath, strategy: TradingStrategyVersion | null, sizing: WorkflowResourceVersion | null) {
  const effective = path.effectiveConfiguration.strategyConfiguration;
  const normalizedSizing = (path.effectiveConfiguration.resources as any)?.sizing;
  return leaves(effective).map(([field, value]) => {
    return { field, value, unit: unit(field), strategyValue: at(strategy?.configuration, field) ?? null,
      strategyValuePresent: at(strategy?.configuration, field) !== undefined,
      ...parameterOrigin(field, normalizedSizing, sizing, strategy), scope: `Revision ${path.workflowRevisionId} · Kanal ${path.channelId} · Konto ${path.accountId}`,
      effect: 'Kompilierter Ausgangswert für Intents dieses Pfads. Signal, adaptive Stufe und Markt-/FX-/Sicherheitsbelege werden im eigenen Tradeplan zusätzlich geprüft.' };
  });
}
