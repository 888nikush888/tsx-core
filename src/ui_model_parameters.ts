import { DEFAULT_STRATEGY_CONFIGURATION } from './trading_strategy.js';
import { BUILTIN_SIGNAL_CONTRACTS } from './signal_contract.js';
import { parameterFields, type FieldSpec, type ParameterFamily } from './ui_parameter_types.js';

const workflowEffect = 'Entwurf speichern, Modell/Ressource publizieren und Graph aktivieren. Nur neue Intents verwenden die neu gepinnte Fassung; Tradeplan und Schutzoriginale bleiben unverändert.';
const workflowFamily = (prefix: string, validator: string, consumer: string): ParameterFamily => ({
  prefix, source: 'Exakte Modell-/Ressourcenfassung; Defaults sind Validator- oder ausdrücklich benannte Vorlagenwerte',
  scope: 'Workflowpfad, Ressource und Version', effect: workflowEffect, href: '/workflows/builder', validator, consumer,
});
export const STRATEGY_PARAMETER_FIELDS: FieldSpec[] = [
  ['schemaVersion', 'integer', '1|2|3|4; neue Versionen werden auf das aktuelle Schema normalisiert'],
  ['allowedSignalSchemas', 'string[]', 'Mindestens eine eindeutige ausführbare Schema-ID'],
  ['allowedSymbols', 'string[]', 'Eindeutige normalisierte Symbole', undefined, 'Leere Liste beschränkt das Symbol nicht.'],
  ['allowedSides', 'enum[]', 'LONG|SHORT; mindestens eine, keine Duplikate'],
  ['entry.orderType', 'enum', 'market|limit'], ['entry.rangePrice', 'enum', 'near|midpoint|far'],
  ['entry.postOnly', 'boolean', 'Für market muss false gelten'], ['entry.timeoutSeconds', 'integer', '2..30', 's'],
  ['sizing.positionSizingMode', 'enum', 'risk_percent|equity_percent_notional|equity_percent_margin; fehlend: risk_percent'],
  ['sizing.riskPerTradePercent', 'decimal-string', '>0..10', '%'],
  ['sizing.maxAdaptiveRiskPercent', 'decimal-string', '>0..10 und >= Basis; nicht in Schema 1', '%'],
  ['sizing.maxPositionNotional', 'decimal-string', '>0', 'Quote-Währung; zusätzlich Markt-/FX-Auflösung im Tradeplan'],
  ['sizing.defaultLeverage', 'integer', '1..50 und <= maxLeverage; Schema 4 erforderlich, zuvor fehlend: maxLeverage', '×'],
  ['sizing.maxLeverage', 'integer', '1..50', '×'],
  ['exits.targetAllocationMode', 'enum', 'manual|adaptive_halving; fehlend: manual'],
  ['exits.targetAllocationsPercent', 'decimal-string[]', '1..20 Werte >0..100; Summe exakt 100', '%'],
  ['exits.stopLossMode', 'enum', 'configured|adaptive_targets; fehlend: configured'],
  ['exits.moveStopToBreakEvenAfterTarget', 'integer|null', '1..Anzahl Ziele', 'Zielnummer (1-basiert)', 'null deaktiviert die konfigurierte Break-even-Regel.'],
  ['exits.trailingStopPercent', 'decimal-string|null', '>0..20', '%', 'null deaktiviert konfiguriertes Trailing.'],
  ['exits.closeRemainderAtLastTarget', 'boolean', 'Unveränderliche Sicherheitsgrenze: true'],
  ['safety.maxDailyLossMode', 'enum', 'absolute|equity_percent; fehlend: absolute'],
  ['safety.maxDailyLoss', 'decimal-string', '>0; equity_percent höchstens 100', 'Reporting-/Quote-Währung oder % gemäß Modus; FX-Nachweise erforderlich'],
  ['safety.maxSlippagePercent', 'decimal-string', '>0..5', '%'],
  ['safety.entryOrderTtlSeconds', 'integer', '10..86400', 's'],
  ['safety.requireProtectiveStop', 'boolean', 'Unveränderliche Sicherheitsgrenze: true'],
  ['safety.maxConcurrentPositions', 'integer', '1..20; ausschließlich Legacy-Schema <3. Seit Schema 3 am Konto.', 'Positionen/Reservierungen'],
];
export const RESOURCE_PARAMETER_FIELDS: Record<string, FieldSpec[]> = {
  channel: [['channelId', 'string', 'Nichtleer, höchstens 128 Zeichen; kanonische Kanal-ID']],
  content_filter: [['allowedTypes', 'string[]', 'Bis 20 eindeutige Einträge; fehlend: text']],
  keyword_filter: [['allowedKeywords', 'string[]', 'Bis 100 eindeutige Einträge', undefined, 'Leer: keine positive Keywordbedingung.'], ['blockedKeywords', 'string[]', 'Bis 100 eindeutige Einträge', undefined, 'Leer: keine Keyword-Sperrliste.']],
  regex: [['patterns', 'string[]', 'Bis 100 eindeutige parseRegex-kompatible Muster'], ['mode', 'enum', 'all|any; fehlend: all']],
  parser: [['templateName', 'string', '1..128 Zeichen; fehlend: default'], ['primaryModel', 'string', 'Optional, 1..128 Zeichen', undefined, 'Fehlend erbt das globale Primärmodell.'],
    ['fallbackModel', 'string', 'Optional, 1..128 Zeichen', undefined, 'Fehlend erbt das globale Fallbackmodell.'],
    ['prompt', 'string', 'Optional, getrimmt 1..50000 Zeichen', 'Zeichen', 'Fehlend verwendet das aufgelöste Template.'],
    ['timeoutMs', 'integer', '2000..120000; fehlend: 120000', 'ms'], ['saveToFile', 'boolean', 'Unveränderliche Workflowgrenze: false']],
  schema: [['schemaId', 'string', '1..64 Zeichen; exakte Schema-ID']],
  contract: [['contractVersionId', 'string', '1..64 Zeichen; exakte Vertragsversion']],
  strategy: [['strategyVersionId', 'string', '1..64 Zeichen; exakte Strategieversion']],
  sizing: STRATEGY_PARAMETER_FIELDS.filter(field => field[0].startsWith('sizing.')).map(([key, ...rest]) => [key.slice(7), ...rest] as FieldSpec),
  adaptive_risk: [['enabled', 'boolean', 'Fehlend: true'], ['mode', 'enum', 'fixed|shadow|automatic; fehlend: automatic'],
    ['tiers', 'object[]', '1..20 Stufen; fehlend: eine Stufe mit 5%'],
    ['tiers[].riskPercent', 'decimal-string', '>0..10; Stufen streng aufsteigend', '%'],
    ['startingTier', 'integer', '0..N-1; fehlend: Legacy-currentTier, sonst 0', 'UI-Stufe 1..N; API-Index 0..N-1'],
    ['lockedTier', 'integer|null', '0..N-1 oder null', 'UI-Stufe 1..N; API-Index 0..N-1', 'null hebt das Festhalten auf; 0 hält ausdrücklich Stufe 1 fest.'],
    ['lookbackWeeks', 'integer', '1..12; fehlend: 1', 'Wochen'], ['minimumClosedTrades', 'integer', '1..1000; fehlend: 5', 'Trades'],
    ['lossThresholdPercent', 'decimal-string', '>0..100; fehlend: 2', '%'], ['profitThresholdPercent', 'decimal-string', '>0..100; fehlend: 2', '%'],
    ['weakChannelAction', 'enum', 'none|reduce|block; fehlend: reduce'], ['weakWeeksBeforeBlock', 'integer', '1..52; fehlend: 3', 'Wochen'],
    ['manuallyBlocked', 'boolean', 'Fehlend: false']],
  account: [['accountId', 'string', '1..64 Zeichen; exaktes Konto']],
  dedupe: [['enabled', 'boolean', 'Fehlend: true'], ['cooldownHours', 'number', '0..8760; fehlend: 24', 'h', '0 sperrt identische Signale dauerhaft; keine Wiederholung von Orders.']],
  output: [['mode', 'enum', 'audit_only|telegram_xml|telegram_original|none; fehlend: audit_only']],
};
// Sizing resources override the strategy; their historical defaults intentionally differ.
RESOURCE_PARAMETER_FIELDS.sizing = [
  ['positionSizingMode', 'enum', 'risk_percent|equity_percent_notional|equity_percent_margin; fehlend: equity_percent_margin'],
  ['riskPerTradePercent', 'decimal-string', '>0..10; erforderlich', '%'],
  ['maxAdaptiveRiskPercent', 'decimal-string', '>0..10 und >= Basis; fehlend: Basis', '%'],
  ['maxPositionNotional', 'decimal-string', '>0; fehlend: 1000000000', 'Quote-Währung des Markts'],
  ['defaultLeverage', 'integer', '1..50 und <= maxLeverage; fehlend: maxLeverage', '×'],
  ['maxLeverage', 'integer', '1..50; fehlend: 1', '×'],
];
const path = '1..96 Zeichen; 1..4 kleingeschriebene XML-Pfadsegmente; Pfade dürfen nicht kollidieren';
export const CONTRACT_PARAMETER_FIELDS: FieldSpec[] = [
  ['schemaVersion', 'integer', 'Unveränderlich 1'], ['rootTag', 'enum', 'Unveränderlich signal'],
  ...['actionPath', 'pairPath', 'stopLossPath', 'entry.minimumPath', 'entry.maximumPath', 'targets.containerPath', 'targets.itemTag', 'targets.minimumPath', 'targets.maximumPath'].map(key => [key, 'string', path] as FieldSpec),
  ...['entry.typePath', 'leveragePath', 'riskPercentPath', 'averagingPricePath'].map(key => [key, 'string|null', path, undefined, 'Leer/null/fehlend entfernt den optionalen Pfad.'] as FieldSpec),
  ['entry.mode', 'enum', 'optional_range|required_range|typed; typed benötigt typePath und beide Wertelisten'],
  ['entry.marketValues', 'string[]', 'Bis 20 eindeutige Werte, je 1..80 Zeichen; nur bei typed'],
  ['entry.rangeValues', 'string[]', 'Bis 20 eindeutige Werte, je 1..80 Zeichen; nur bei typed'],
  ['targets.shape', 'enum', 'scalar|range'], ['targets.minimumItems', 'integer', '1..20', 'Ziele'],
  ['targets.maximumItems', 'integer', 'minimumItems..20', 'Ziele'], ['targets.sequentialIds', 'boolean', 'true|false'],
  ...['geometry.stopOnLossSide', 'geometry.targetsOnProfitSide', 'geometry.orderedTargets', 'geometry.orderedRanges',
    'grounding.action', 'grounding.pair', 'grounding.entry', 'grounding.targets', 'grounding.stopLoss', 'grounding.leverage', 'grounding.riskPercent', 'grounding.averagingPrice'].map(key => [key, 'boolean', 'true|false; geprüfte Policy, keine automatische Aufhebung von Handels-/Eigentumsgrenzen'] as FieldSpec),
  ['additionalFields', 'object[]', 'Bis 30 Zusatzfelder'], ['additionalFields[].path', 'string', path],
  ['additionalFields[].type', 'enum', 'text|decimal|integer|boolean'], ['additionalFields[].required', 'boolean', 'true|false'],
  ['additionalFields[].allowedValues', 'string[]', 'Bis 50 eindeutige Werte, je 1..80 Zeichen'],
  ['additionalFields[].minimum', 'decimal-string', 'Optional; nichtnegativ und <= maximum', undefined, 'Leer/fehlend: keine untere Zusatzfeldgrenze.'],
  ['additionalFields[].maximum', 'decimal-string', 'Optional; nichtnegativ und >= minimum', undefined, 'Leer/fehlend: keine obere Zusatzfeldgrenze.'],
  ['additionalFields[].maximumLength', 'integer', 'Optional 1..2000', 'Zeichen'],
  ['additionalFields[].pattern', 'string', 'Optional, bis 160 Zeichen; sichere Teilmenge ohne Lookaround/Backreferences'],
];
export function uiModelParameters() {
  const strategy = parameterFields(workflowFamily('strategy', 'src/trading_strategy.ts:validateStrategyConfiguration', 'src/trading_engine.ts'), STRATEGY_PARAMETER_FIELDS, DEFAULT_STRATEGY_CONFIGURATION)
    .map(field => ({ ...field, editable: !['strategy.schemaVersion', 'strategy.exits.closeRemainderAtLastTarget', 'strategy.safety.requireProtectiveStop', 'strategy.safety.maxConcurrentPositions'].includes(field.path) }));
  const resources = Object.entries(RESOURCE_PARAMETER_FIELDS).flatMap(([kind, fields]) =>
    parameterFields(workflowFamily('resource.' + kind, 'src/workflow_repository.ts:RESOURCE_VALIDATORS', 'src/workflow_repository.ts; src/trading_engine.ts'), fields))
    .map(field => ({ ...field, editable: field.path !== 'resource.parser.saveToFile' }));
  const contracts = ['schema.definition', 'contract.definition'].flatMap(prefix =>
    parameterFields(workflowFamily(prefix, 'src/signal_contract.ts:validateSignalContractDefinition', 'src/signal_contract.ts:composeSignalSchemaContract; src/signal_schema.ts'), CONTRACT_PARAMETER_FIELDS, BUILTIN_SIGNAL_CONTRACTS[0].definition))
    .map(field => ({ ...field, editable: !field.path.endsWith('.schemaVersion') && !field.path.endsWith('.rootTag') }));
  const metadata = ['resource', 'strategy', 'schema', 'contract'].flatMap(prefix => parameterFields(workflowFamily(prefix,
    prefix === 'resource' ? 'src/workflow_repository.ts' : 'src/trading_repository.ts', 'src/workflow_repository.ts; src/trading_engine.ts'), [
    ['name', 'string', 'Getrimmter sichtbarer Name, 1..80 Zeichen'], ['description', 'string', 'Bis 500 Zeichen', undefined, 'Leer entfernt die Beschreibung im Entwurf.'],
    ['id', 'string', 'Unveränderliche Objekt-/Versions-ID; Neuanlage folgt eigenem ID-Vertrag'],
  ]).map(field => ({ ...field, editable: !field.path.endsWith('.id') || prefix === 'schema' || prefix === 'contract',
    ...(field.path.endsWith('.id') && ['schema', 'contract'].includes(prefix) ? {
      constraints: 'Bei Neuanlage: Kleinbuchstabe, danach bis 39 Kleinbuchstaben/Ziffern/_/-; eindeutig. Bestehende Original-ID bleibt unveränderlich.',
      effect: 'Nur neue Schema-/Vertragsfamilie oder ausdrücklich kopiertes Schema. Bearbeitete Originale erhalten eine neue ID; keine Umbenennung historischer Referenzen.' } : {}) })));
  const schemaMetadata = parameterFields(workflowFamily('schema', 'src/trading_repository.ts:signalSchemaInput', 'src/signal_schema.ts'), [
    ['templateName', 'string', '1..64 Buchstaben, Ziffern, _ und -; UI übernimmt die zugeordnete Parserquelle'],
    ['parserSchema', 'enum', 'standard|cryptodanielvip|loma; Kompatibilitätsvertrag; aus Parser-/Vertragszuordnung abgeleitet'],
    ['contractVersionId', 'string|null', 'Publizierte Fallback-Vertragsversion; eigene Definition bleibt Originalinhalt'],
    ['enabled', 'boolean', 'true|false; Lifecycle muss bestehende Referenzen beachten'],
  ]).map(field => ({ ...field, editable: field.path.endsWith('.enabled') }));
  return [...strategy, ...resources, ...contracts, ...metadata, ...schemaMetadata];
}
