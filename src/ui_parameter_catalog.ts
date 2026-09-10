import { DEFAULT_CONFIG } from './config.js';
import { DEFAULT_RUNTIME_SETTINGS } from './runtime_settings.js';
import { RUNTIME_INTEGER_RANGES, runtimeFieldUnit } from './ui_runtime_contract.js';
import { DEFAULT_TELEGRAM_VIEWER_SETTINGS } from './telegram_viewer_settings.js';
import { AI_LIMIT_RANGES, AI_LIMIT_LABELS } from './ui_contracts.js';
import { uiModelParameters } from './ui_model_parameters.js';
import { parameterFields, parameterLeaves, type FieldSpec, type ParameterFamily, type UiParameter } from './ui_parameter_types.js';
import { decodeUiCursor, encodeUiCursor, filterFingerprint } from './ui_cursor.js';

const configFamily: ParameterFamily = {
  prefix: 'config', source: 'Normalisierte verwaltete Konfiguration; konkrete gespeicherte Werte unter Telegram & Queue',
  scope: 'Installation; Legacy-Quellenwerte werden von gepinnten Workflow-Ressourcen abgelöst',
  effect: 'Queue und KI-Grenzen für neue Arbeit; Telegram-Verbindungsdaten beim nächsten Verbindungsaufbau. Gespeicherte Rückgabewerte können normalisiert sein.',
  href: '/signals/telegram', validator: 'src/config.ts:validateConfig', consumer: 'src/forwarder.ts; src/signal_parser.ts',
};
export const CONFIG_PARAMETER_FIELDS: FieldSpec[] = [
  ['apiId', 'integer', 'Sichere Ganzzahl >=0; ungültig normalisiert auf 0', undefined, '0 bedeutet keine nutzbare Telegram API ID.'],
  ['sourceChannels', 'string[]', 'Kanonische Telegram-Quellen oder auflösbare Namen'],
  ['targetChannel', 'string', 'Telegram-Ziel; Auflösung bei Verbindungsaufbau'],
  ...['sendCopy', 'removeCaption', 'forwardToTarget'].map(key => [`forwardOptions.${key}`, 'boolean', 'true|false'] as FieldSpec),
  ['forwardOptions.maxConcurrency', 'integer', '1..100; ungültig wird auf Default normalisiert', 'gleichzeitige Queue-Aufträge'],
  ['forwardOptions.queueTimeoutSeconds', 'integer', '0..86400; positive Werte bei aktivem Parser mindestens Requesttimeout + 5 s', 's', '0 deaktiviert dieses Queue-Zeitlimit.'],
  ...['allowedKeywords', 'blockedKeywords', 'allowedTypes', 'regexPatterns'].map(key => [`filters.${key}`, 'string[]', 'Legacy-Filter für neu angenommene Nachrichten; Muster über parseRegex', undefined, 'Leere Liste bedeutet keine Bedingung dieser Liste.'] as FieldSpec),
  ['sourceFilters', 'record', 'Kanonische Quell-ID → regexPatterns; unzulässige Quellen werden zurückgewiesen', undefined, 'Fehlende Quelle erbt globale Regex; [] ist ausdrücklich leer.'],
  ['sourceAliases', 'record', 'Kanonische Quell-ID → sichtbarer Alias', undefined, 'Entfernen löscht den Alias.'],
  ...['enabled', 'externalDataPolicyAccepted', 'saveToFile', 'forwardXmlToTarget'].map(key => [`xmlParsing.${key}`, 'boolean', 'true|false; Dateiausgabe nur Legacy'] as FieldSpec),
  ['xmlParsing.signalsDir', 'string', 'Legacy-Dateiausgabe; kein Wartungs-/Shellcommand'],
  ['xmlParsing.sourceTemplates', 'record', 'Kanonische Quell-ID → Template', undefined, 'Fehlende Zuordnung erbt den Parserstandard.'],
  ['xmlParsing.primaryModel', 'string', '1..128 Zeichen: Buchstaben, Ziffern, . _ : / -; ungültig normalisiert auf Default'],
  ['xmlParsing.fallbackModel', 'string', '1..128 Zeichen: Buchstaben, Ziffern, . _ : / -; ungültig normalisiert auf Default'],
  ['xmlParsing.timeout', 'integer', 'Legacy-Parser-Gesamtzeitlimit; globale Requestgrenze und Workflowtimeout gelten separat', 'ms', '0/fehlend verwendet den bisherigen Parserstandard.'],
  ...Object.entries(AI_LIMIT_RANGES).map(([key, range]) => [`xmlParsing.aiLimits.${key}`, 'integer', `${range.join('..')}; ungültig normalisiert auf Default`,
    AI_LIMIT_LABELS[key as keyof typeof AI_LIMIT_LABELS][1]] as FieldSpec),
  ['dupeBlocker.enabled', 'boolean', 'true|false'],
  ['dupeBlocker.cooldownHours', 'number', 'Legacy-Cooldown, nichtnegativ; Workflowvariante separat begrenzt', 'h', '0 sperrt identische Signale dauerhaft.'],
];
function runtimeParameters() {
  const family: ParameterFamily = { prefix: 'runtime', source: 'Verwaltete Runtime; tatsächliche gespeicherte und beim Start aktive Werte im Runtimeformular',
    scope: 'Installation; verwaltete Werte ersetzen gemappte Umgebungswerte beim Start', effect: 'Gespeichert sofort; aktiv nach Neustart. Zugangsänderungen können Sitzungen sofort widerrufen.',
    href: '/operations/settings', validator: 'src/runtime_settings.ts:validateRuntimeSettings', consumer: 'src/runtime_settings.ts:applyToEnvironment; src/forwarder.ts', requiresRestart: true };
  const fields: FieldSpec[] = Object.entries(DEFAULT_RUNTIME_SETTINGS).map(([key, value]) => {
    const range = RUNTIME_INTEGER_RANGES[key as keyof typeof RUNTIME_INTEGER_RANGES];
    const type = typeof value === 'number' ? 'integer' : typeof value;
    const constraints = runtimeConstraints(key, value, range);
    return [key, type, constraints, runtimeFieldUnit(key) ?? undefined] as FieldSpec;
  });
  return parameterFields(family, fields, DEFAULT_RUNTIME_SETTINGS);
}
function viewerParameters() {
  const rules: Record<string, string> = { allowedUserIds: 'Eindeutige numerische Telegram User-IDs; bis 100',
    timezone: 'Gültige IANA-Zeitzone; 1..100 Zeichen', locale: 'Gültiger Intl.Locale-Sprachcode; 2..35 Zeichen', eventPollingIntervalMs: '1000..60000',
    'display.detailLevel': 'compact|normal|detailed', 'display.pnlMode': 'absolute|absolute_and_percent', 'display.timeFormat': '24h (unveränderlich)' };
  const fields: FieldSpec[] = parameterLeaves(DEFAULT_TELEGRAM_VIEWER_SETTINGS).map(key => [
    key, viewerFieldType(key),
    rules[key] ?? 'true|false', key.endsWith('Ms') ? 'ms' : undefined,
  ]);
  return parameterFields({ prefix: 'viewer', source: 'Separater Telegram-Viewer-Store', scope: 'Viewer-Service; getrennt vom Telegram-Benutzerlogin',
    effect: 'Viewer liest die gespeicherte Konfiguration. Versandabschluss wird als eigener Testevent beobachtet.', href: '/integrations/telegram-viewer',
    validator: 'src/telegram_viewer_settings.ts:validateTelegramViewerSettings', consumer: 'src/telegram_viewer/runtime.ts' }, fields, DEFAULT_TELEGRAM_VIEWER_SETTINGS)
    .map(field => ({ ...field, editable: field.path !== 'viewer.display.timeFormat' }));
}
const objects = (prefix: string, scope: string, href: string, validator: string, consumer: string, effect: string): ParameterFamily =>
  ({ prefix, source: 'Ausgewähltes serverseitiges Objekt; keine Installation eines Defaultwerts durch dieses Verzeichnis', scope, href, validator, consumer, effect });
function objectParameters() {
  return [
    ...parameterFields(objects('account', 'Konto; gemeinsame Kapazität über alle Pfade', '/trading/accounts', 'src/trading_web_control.ts', 'src/trading_engine.ts; src/trading_repository.ts',
      'Kontoanlage, Verifikation und geschützte Zustandsänderung wirken unabhängig von Ressourcenpublikation.'), [
      ['name', 'string', 'Bei Anlage; nichtleer, 1..80 Zeichen. Danach unveränderlich.'], ['exchange', 'string', 'Bei Anlage; zertifizierte Börsen-ID aus dem Katalog. Danach unveränderlich.'], ['mode', 'enum', 'Bei Anlage paper|testnet|live. Danach unveränderlich.'],
      ['enabled', 'boolean', 'true|false; geschützter Zustandswechsel'], ['maxConcurrentPositions', 'integer', '1..20; baseStateVersion erforderlich', 'Positionen und Reservierungen'],
      ['stateVersion', 'integer', 'Read-only Versionsbeleg'], ['status', 'enum', 'unverified|ready|disabled|error|degraded; Ergebnis der Verifikation'],
      ['killSwitchActive', 'boolean', 'Setzen und geschütztes Freigeben sind separate Commands; keine direkte Konfigurationsabkürzung'],
      ['credentialGeneration', 'integer', 'Read-only Credential-Epoche'], ['lastVerifiedAt', 'timestamp|null', 'Originalzeitpunkt, kein Frischeersatz', 'Unix ms'],
    ]).map(field => ({ ...field, editable: ['account.name', 'account.exchange', 'account.mode', 'account.enabled', 'account.maxConcurrentPositions'].includes(field.path) })),
    ...parameterFields(objects('journal.review', 'Review eines Intents', '/trading/journal', 'src/trade_journal.ts:updateTradeJournalReview', 'src/trade_journal.ts', 'Nur Reviewdaten; niemals Order, Fill, Plan oder Herkunft.'), [
      ['notes', 'string', 'Bis 10000 Zeichen', undefined, 'Leer löscht die Notiz.'], ['tags', 'string[]', 'Bis 20 eindeutige Tags; jeweils bis 40 Zeichen', undefined, '[] entfernt die Tags.'],
      ['rating', 'integer|null', '1..5', 'Bewertung', 'null entfernt die Bewertung.'], ['reviewed', 'boolean', 'true|false; false ist ausdrücklich nicht geprüft'],
    ]),
    ...parameterFields(objects('mcp.agent', 'Agent und eigene Token-/Sessiongeneration', '/integrations/mcp', 'src/mcp_repository.ts', 'src/mcp_control_bridge.ts',
      'Änderungen sind CAS-gebunden. Rotation liefert ein neues Token einmalig; Freigabe bleibt an konkrete Vorschläge gebunden.'), [
      ['name', 'string', 'Nichtleer, bis 80 Zeichen'], ['permissions', 'enum[]', 'Eindeutige Werte aus MCP_PERMISSIONS; kein freier Tool-Runner'],
      ['eventSubscriptions', 'enum[]', 'Eindeutige Werte aus TRADING_EVENT_TYPES'], ['enabled', 'boolean', 'true|false'],
    ]),
    ...parameterFields(objects('mcp.runtime', 'MCP-Service', '/integrations/mcp', 'src/mcp_repository.ts', 'src/mcp_control_bridge.ts', 'Aktivierung/Deaktivierung benötigt eigenen geprüften Command.'), [['mode', 'enum', 'active|standby|disabled']]),
    ...parameterFields(objects('graph', 'Exakter Graphentwurf und Basisrevision', '/workflows/builder', 'src/workflow_repository.ts; src/ui_workflow_drafts.ts', 'src/workflow_repository.ts; src/trading_engine.ts', 'Speichern ist keine Aktivierung. Aktivierung prüft Draftrevision, Basis und Auswirkungen gemeinsam.'), [
      ['nodes[].id', 'string', 'Eindeutige Node-ID; Graphvalidator'], ['nodes[].resourceVersionId', 'string', 'Exakte Ressourcenfassung'],
      ['schemaVersion', 'integer', '1|2|3; vom Builder erzeugter Graphvertrag'], ['nodes[].kind', 'enum', 'Eine der 13 registrierten Bausteinarten; muss zur Ressourcenfassung passen'],
      ['nodes[].position.x', 'number', 'Endliche Canvas-Koordinate', 'px'], ['nodes[].position.y', 'number', 'Endliche Canvas-Koordinate', 'px'],
      ['edges[].source', 'string', 'Vorhandene Quellnode'], ['edges[].target', 'string', 'Vorhandene Zielnode'],
      ['edges[].id', 'string', 'Eindeutige Verbindungs-ID'], ['edges[].kind', 'enum', 'flow|account_fallback; fehlend: flow'],
      ['edges[].channelNodeIds', 'string[]', 'Nur vorhandene Kanalnodes', undefined, 'Fehlend erlaubt jede Quellkanallinie, die die Verbindung erreicht.'],
      ['edges[].fallbackOn', 'enum[]', 'SYMBOL_UNAVAILABLE|MAX_CONCURRENT_POSITIONS|SYMBOL_ALREADY_OWNED; keine Wiederholung nach unbekanntem Orderergebnis'],
      ['baseRevisionId', 'string|null', 'Read-only Optimistic-Concurrency-Basis'], ['editRevision', 'integer', 'Read-only gespeicherte Entwurfsrevision'],
    ]).map(field => ({ ...field, editable: !['graph.baseRevisionId', 'graph.editRevision'].includes(field.path) })),
  ];
}
function boundaryParameters() {
  return [
    ...parameterFields({ ...objects('secrets', 'Je Installation oder ausgewähltes Konto/Viewer', '/operations/settings', 'src/secret_store.ts; src/trading_credentials.ts; src/telegram_viewer_secrets.ts',
      'src/forwarder.ts; src/trading_web_control.ts', 'Separater Secretcommand; Rotation und Verbindungs-/Sitzungsfolgen werden vor Bestätigung gezeigt.'), secret: true }, [
      ['telegramApiHash', 'secret', 'Nur neue Eingabe; gespeicherter Inhalt wird nie gelesen'], ['openRouterApiKey', 'secret', 'Nur neue Eingabe'],
      ['dashboardToken', 'issued-secret', 'Servergeneriert; einmalige Ausgabe; keine frei gewählte Tokenkonfiguration'],
      ['exchangeCredentials', 'secret-object', 'Börsenspezifische Felder aus zertifiziertem Katalog; Rotation pausiert global neue Entries'],
      ['viewerBotToken', 'secret', 'Getrennter Bot-Token; explizit ersetzen/löschen'], ['viewerServiceToken', 'issued-secret', 'Servergeneriert; einmalige Ausgabe'],
      ['mcpAgentToken', 'issued-secret', 'Servergeneriert; einmalige Ausgabe'],
    ]).map(field => ({ ...field, editable: field.type !== 'issued-secret' })),
    ...parameterFields({ ...objects('deployment', 'Browserbuild oder Host-/Compose-Deployment', '/operations/deployment', '.env.example; frontend/vite.config.ts',
      'docker-compose.yml; frontend/src/App.tsx', 'Benötigt kontrollierten Neubuild oder Host-Deployment; Speichern im laufenden Core ändert keinen vorhandenen Browserbuild.'), editable: false, requiresRestart: true }, [
      ['VITE_BASENAME', 'string', 'Browser-Basisadresse zur Buildzeit'], ['VITE_GTM_ID', 'string', 'Optionaler bestehender Buildwert; Verzeichnis aktiviert kein Tracking'],
      ['hostPorts', 'deployment', 'Host-/Compose-Portbindung'], ['cpu', 'deployment', 'Host-/Container-Ressourcengrenze'], ['memory', 'deployment', 'Host-/Container-Ressourcengrenze'],
      ['imageDigest', 'deployment', 'Geprüfter Image-Digest; Offline-Rollback erfordert unabhängigen Hostzugriff'],
    ]),
  ];
}
function paperParameters() {
  return parameterFields(objects('paper', 'Ausschließlich Paper-Konto; niemals Live/Testnet', '/trading/paper', 'src/paper_exchange.ts:setBalance/setMarket',
    'src/paper_exchange.ts', 'Versionsgebundene Änderung von Balance und/oder Markt. Ein neuer Markpreis kann bestehende simulierte Orders ausführen.'), [
    ['equity', 'decimal-string', '>0', 'USDT (Paper-Vertrag)'],
    ['availableBalance', 'decimal-string', '>=0 und <= equity; fehlend: equity', 'USDT (Paper-Vertrag)'],
    ['market.symbol', 'string', '2..20 Großbuchstaben/Ziffern'],
    ['market.markPrice', 'decimal-string', '>0', 'Preis in Quote-Währung'],
    ['market.priceTick', 'decimal-string', '>0', 'Preisschritt'],
    ['market.quantityStep', 'decimal-string', '>0', 'Mengenschritt'],
    ['market.minimumQuantity', 'decimal-string', '>0', 'Basismenge'],
    ['market.minimumNotional', 'decimal-string', '>0', 'Quote-Währung'],
    ['market.maxLeverage', 'integer', '1..125 gespeichert; ausführbarer Snapshot zusätzlich auf 50 begrenzt', '×'],
  ]);
}
export function uiParameterCatalog(): UiParameter[] {
  return [...runtimeParameters(), ...parameterFields(configFamily, CONFIG_PARAMETER_FIELDS, DEFAULT_CONFIG), ...viewerParameters(),
    ...uiModelParameters(), ...objectParameters(), ...paperParameters(), ...boundaryParameters()];
}
function selectedParameterPrefix(query: URLSearchParams): string {
  const prefix = query.get('prefix') ?? '';
  if (!/^[a-zA-Z0-9._-]{0,80}$/.test(prefix)) throw new Error('Invalid parameter filters.');
  return prefix;
}

function selectedParameterLimit(query: URLSearchParams): number {
  const limit = Number(query.get('limit') ?? 30);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('Invalid parameter filters.');
  return limit;
}

function parameterSelection(query: URLSearchParams): { prefix: string; limit: number } {
  return { prefix: selectedParameterPrefix(query), limit: selectedParameterLimit(query) };
}

function parameterCursorOffset(entries: { path: string }[], cursor: { id: string } | null): number {
  const offset = cursor ? Number(cursor.id) : 0;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > entries.length) throw new Error('Invalid parameter cursor.');
  return offset;
}

export function uiParameters(query: URLSearchParams) {
  const { prefix, limit } = parameterSelection(query);
  const catalog = uiParameterCatalog(); const filter = filterFingerprint({ catalog, prefix, limit });
  const cursor = decodeUiCursor(query.get('cursor'), filter); const observedAt = cursor?.observedAt ?? Date.now();
  const entries = catalog.filter(item => item.path.startsWith(prefix)); const offset = parameterCursorOffset(entries, cursor);
  const hasMore = entries.length > offset + limit;
  return { contractVersion: 1, observedAt, total: entries.length, entries: entries.slice(offset, offset + limit), hasMore,
    nextCursor: hasMore ? encodeUiCursor({ version: 1, filter, observedAt, createdAt: 0, id: String(offset + limit) }) : null,
    interpretation: 'Versionierter Feldvertrag, keine aktuellen Objektwerte. Gespeicherte und wirksame Werte mit Herkunft stehen in der verlinkten Fachansicht. Secrets werden nie zurückgegeben.' };
}

function runtimeConstraints(key: string, value: unknown, range: readonly number[] | undefined): string {
  if (range) return range.join('..');
  if (typeof value === 'boolean') return 'true|false';
  return key === 'dashboardAuthMode' ? 'token|oidc|tailscale; abhängige Profilfelder werden gemeinsam validiert'
    : 'Getrimmter Text ohne CR/LF/NUL; URL-/Origin-/Profilregeln gemäß Runtimeformular';
}
function viewerFieldType(key: string): string {
  if (key === 'eventPollingIntervalMs') return 'integer';
  if (key === 'allowedUserIds') return 'string[]';
  return key === 'enabled' || key.startsWith('notifications.') ? 'boolean' : 'string';
}
