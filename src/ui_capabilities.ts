import { UI_ROUTE_INVENTORY } from './ui_route_inventory.js';
import { decodeUiCursor, encodeUiCursor, filterFingerprint } from './ui_cursor.js';

type Group = { paths: readonly string[]; label: string; scope: string; href: string; component: string; effect: string; contractTests: string[]; browserTests: string[]; boundary?: string };
const browserTests = ['frontend/e2e/ui-next.spec.ts', 'frontend/e2e/dashboard.spec.ts'];
function group(paths: string, label: string, scope: string, href: string, component: string, effect: string, evidence: Pick<Group, 'contractTests' | 'boundary'>): Group {
  const { contractTests, boundary } = evidence;
  return { paths: paths.split(' '), label, scope, href, component, effect, contractTests, browserTests, ...(boundary ? { boundary } : {}) };
}
/** Explicit product mapping. Adding a route without assigning it fails the register contract. */
export const UI_CAPABILITY_GROUPS: Group[] = [
  group('/api/status /api/ui/attention /api/control /api/trading/runtime /api/trading/cancel-entries /api/trading/emergency-flatten /api/trading/reconcile /api/trading/risk/acknowledge',
    'Betriebsfreigaben und Risikoreduktion', 'Global oder ausdrücklich ausgewähltes Konto', '/cockpit', 'frontend/src/features/cockpit/overview.tsx',
    'Start/Stop des Routings, neue Entries, Live-Erlaubnis, Kill-Switch und Risikoreduktion sind getrennte Befehle. Börsenabschluss benötigt eigene Originalbelege.', { contractTests: ['tests/test_trading_web_control.js', 'tests/test_web_server.js'] }),
  group('/api/trading /api/trading/portfolio /api/exchanges/catalog /api/exchanges/probe /api/trading/accounts /api/trading/accounts/credentials /api/trading/accounts/verify /api/trading/accounts/state /api/trading/accounts/configuration /api/trading/accounts/kill-switch/release /api/trading/accounts/detail',
    'Konten und Börsen', 'Konto; Credentialrotation pausiert zusätzlich global neue Entries und setzt den globalen Kill-Switch', '/trading/accounts', 'frontend/src/features/accounts/accounts.tsx',
    'Kontoanlage, Verifikation, Kapazität und Wartung. Portfolioabrufe können Provider lesen und neue Equity-Beobachtungen speichern; kein Entry-Nachweis.', { contractTests: ['tests/test_trading_web_control.js', 'tests/test_ui_next_reads.js'] }),
  group('/api/trading/accounts/evidence', 'Kontorisiko und Providerhistorie', 'Konto und ursprüngliche Beobachtung', '/risk/accounts', 'frontend/src/features/risk-analytics/account-evidence.tsx',
    'Gespeicherte Belege, Reservierungen und Checkpoints lesen; kein Fortschreiben der Providerhistorie.', { contractTests: ['tests/test_ui_next_reads.js'] }),
  group('/api/trading/risk/adaptive /api/trading/risk/adaptive/copy-legacy', 'Adaptive Policen', 'Kanal, Konto und ursprüngliche Policy-Version', '/risk/adaptive', 'frontend/src/features/risk-analytics/adaptive-risk.tsx',
    'Originalauswertungen lesen oder Legacy-Policy als geprüften Ressourcenentwurf kopieren. Keine automatische Aktivierung.', { contractTests: ['tests/test_ui_adaptive_risk.js'] }),
  group('/api/trading/objects /api/trading/intents/detail /api/trading/intents/relations', 'Trade-Belege', 'Konto, Intent, Order, Position oder Operation', '/trading/positions', 'frontend/src/features/trades/trade-detail.tsx',
    'Originale und aktuelle Projektionen getrennt lesen; keine manuelle Einzeltrade-Ausführung.', { contractTests: ['tests/test_ui_next_reads.js'] }),
  group('/api/trading/journal /api/trading/journal/export', 'Journal und Review', 'Gefilterte Intents; Review eines Intents', '/trading/journal', 'frontend/src/features/journal/journal-page.tsx',
    'Review ändert ausschließlich Notiz, Tags, Bewertung und Reviewstatus. Export verwendet dieselben fachlichen Filter.', { contractTests: ['tests/test_trade_journal_streams.js', 'tests/test_ui_next_reads.js'] }),
  group('/api/trading/analytics /api/dashboard-analytics', 'Analyse', 'Zeitraum, Konto, Kanal, Börse, Modus und Status', '/risk/analytics', 'frontend/src/features/risk-analytics/analytics.tsx',
    'Historische Geld- und Leistungsbelege; fehlende Währung bleibt unbekannt.', { contractTests: ['tests/test_trading_analytics.js'] }),
  group('/api/trading/paper', 'Paper-Labor', 'Ausschließlich Paper-Konto und Paper-Märkte', '/trading/paper', 'frontend/src/features/trades/paper-lab.tsx',
    'Kontostand und Marktdaten werden gemeinsam versionsgeprüft gespeichert. Keine Live-/Testnet-Konfiguration.', { contractTests: ['tests/test_ui_next_reads.js'] }),
  group('/api/signals/ingress /api/signals/ingress/detail /api/signals/ingress/relations /api/signals/processed /api/signals/messages /api/signals/original /api/incoming-messages /api/processed-signals',
    'Signalweg und Parseroriginale', 'Eingang, Album, Signal und gepinnter Ausführungspfad', '/signals/messages', 'frontend/src/features/signals/signals-page.tsx',
    'Beziehungen lesen. Löschung nur der ausgewählten Betriebsnachricht und nur ohne verbotene Handelsreferenzen.', { contractTests: ['tests/test_ui_next_reads.js', 'tests/test_web_server.js'] }),
  group('/api/outbox /api/outbox/page /api/outbox/retry /api/outbox/acknowledge', 'Versand und Bestätigung', 'Outbox-Auftrag und ursprüngliches Ziel', '/signals/outbox', 'frontend/src/features/signals/signals-page.tsx',
    'Manueller Retry kann eine bereits zugestellte Nachricht duplizieren. Manuelle Bestätigung ist kein Provider-Zustellnachweis.', { contractTests: ['tests/test_ui_next_reads.js', 'tests/test_web_server.js'] }),
  group('/api/telegram-login /api/config', 'Telegram, Queue und KI-Grenzen', 'Installation; geerbte Kanal-/Workflowwerte gesondert', '/signals/telegram', 'frontend/src/features/signals/telegram-settings.tsx',
    'Konfiguration mit Versionsvergleich speichern, Queuewerte normalisieren und Telegram-Anmeldung fortsetzen. Session-/Providerstatus gesondert beobachten.', { contractTests: ['tests/test_web_server.js', 'tests/test_ui_operator_commands.js'] }),
  group('/api/access /api/secrets /api/access-tokens /api/access-tokens/viewer /api/runtime-settings /api/factory-reset /api/clear-database',
    'Zugang, Laufzeit und kontrolliertes Zurücksetzen', 'Installation; bestehende Sitzungen können widerrufen werden', '/operations/settings', 'frontend/src/features/operations/system.tsx',
    'Gespeicherte Runtimewerte wirken beim Neustart; Zugangsänderungen können sofort Sitzungen widerrufen. Reset benötigt eigene Bestätigung und Backup-Gates.', { contractTests: ['tests/test_runtime_settings.js', 'tests/test_web_server.js'] }),
  group('/api/recovery /api/restart', 'Recovery und Neustart', 'Dienstinstanz und geprüfte Reparaturwerte', '/recovery', 'frontend/src/features/operations/recovery-page.tsx',
    'Reparieren und Neustart beobachten. Eine neue Instanz bestätigt keinen gesunden Handelszustand.', { contractTests: ['tests/test_ui_operator_commands.js', 'tests/test_web_server.js'] }),
  group('/api/operations /api/operations/backup /api/backups /api/backups/verify /api/backups/recover-offsite /api/backups/restore /api/operations/backup-drill',
    'Backup und Wiederherstellung', 'Servergeführtes Artefakt und Installation', '/operations/backups', 'frontend/src/features/operations/backups-page.tsx',
    'Integrität, Offsite-Nachweis, isolierter Drill und Restore sind getrennte Ergebnisse. Keine freien Dateipfade.', { contractTests: ['tests/test_ui_operator_commands.js', 'tests/test_ui_operation_store.js'] }),
  group('/api/operations/jobs', 'Wartungsaufträge', 'Auftrag, anfragender Actor und angenommener Scope', '/operations/jobs', 'frontend/src/features/operations/jobs-page.tsx',
    'Dauerhaften Auftragsstatus lesen. Unbekannter Ausgang erlaubt kein automatisches Wiederholen.', { contractTests: ['tests/test_ui_operation_store.js'] }),
  group('/api/operations/audit-replay /api/logs /api/metrics-history', 'Audit und Diagnose', 'Installation und begrenzter Logcursor', '/operations/logs', 'frontend/src/features/operations/logs.tsx',
    'Logdiagnose; Audit-Replay wird im Systembereich ausdrücklich angefordert und ist keine Mutation von Handelsoriginalen.', { contractTests: ['tests/test_web_server.js'] }),
  group('/api/setup-bundle/export /api/setup-bundle/preview /api/setup-bundle/review /api/setup-bundle/apply', 'Portables Setup', 'Geprüfter Graph, komplette betroffene Bibliothek und Kontozuordnung', '/operations/settings', 'frontend/src/features/operations/system.tsx',
    'Preview bindet Inhalt und aktuellen Bestand. Apply prüft erneut, sichert und übernimmt das freigegebene Setup.', { contractTests: ['tests/test_setup_bundle.js', 'tests/test_ui_change_reviews.js'] }),
  group('/api/workflow /api/workflow/drafts /api/workflow/mutate /api/workflow/impact /api/workflow/history /api/workflow/history/impact /api/workflow/history/apply /api/workflow/history/reset',
    'Graphentwurf, Aktivierung und History', 'Graphentwurf und exakte aktive Revision', '/workflows/builder', 'frontend/src/app/workflow/workflow-builder.tsx',
    'Entwurf speichern, Ressourcen publizieren und Graph aktivieren sind getrennte Schritte. History prüft Auswirkungen und neue Basisrevision.', { contractTests: ['tests/test_ui_change_reviews.js', 'tests/test_workflow_migration.js'] }),
  group('/api/workflow/objects', 'Versionen und effektive Parameter', 'Unveränderliche Originalrevision und Ressourcenfassung', '/workflows/resources', 'frontend/src/features/workflows/workflow-library.tsx',
    'Originale mit Integritätsnachweis und Herkunft lesen; vergangene Historie wird nicht umgeschrieben.', { contractTests: ['tests/test_ui_change_reviews.js'] }),
  group('/api/workflow/resources /api/workflow/resources/update /api/workflow/resources/publish', 'Workflow-Bausteine', 'Ein Ressourcenentwurf oder ausdrücklich seine Modellabhängigkeit', '/workflows/builder', 'frontend/src/app/workflow/resource-editor.tsx',
    '13 Bausteinarten; neue Versionen statt Änderungen an publizierten Originalen. Veröffentlichung ist keine Graphaktivierung.', { contractTests: ['tests/test_ui_change_reviews.js', 'tests/test_ui_next_reads.js'] }),
  group('/api/workflow/models /api/trading/strategies /api/trading/strategies/update /api/trading/strategies/publish /api/trading/strategies/archive /api/trading/signal-schemas /api/trading/signal-schemas/update /api/trading/signal-contracts /api/trading/signal-contracts/versions /api/trading/signal-contracts/update /api/trading/signal-contracts/duplicate /api/trading/signal-contracts/publish /api/trading/signal-contracts/archive /api/trading/signal-contracts/drafts /api/trading/signal-contracts/validate',
    'Strategien, Schemas und Verträge', 'Exakte Modellversion und ihre zurückbehaltenen Referenzen', '/workflows/models/strategy', 'frontend/src/features/workflows/model-library.tsx',
    'Modell entwerfen, an Ressourcen binden und Lifecycle prüfen. Erfolgreich angelegte Teilobjekte bleiben auffindbar.', { contractTests: ['tests/test_ui_change_reviews.js'] }),
  group('/api/workflow/simulate /api/workflow/parser-test /api/workflow/parser-test/preview', 'Workflow- und KI-Test', 'Geprüfter Testinput, Modelle, Prompt, Schema und Grenzen', '/workflows/tests', 'frontend/src/features/workflows/test-lab.tsx',
    'Lokale Simulation oder ausdrücklich genehmigter externer KI-Test mit echten Quoten. Keine Orders, Intents, Dateien oder Outbox-Aufträge.', { contractTests: ['tests/test_ui_operator_commands.js'] }),
  group('/api/mcp /api/mcp/proposals/detail /api/mcp/runtime /api/mcp/agents /api/mcp/agents/update /api/mcp/agents/rotate /api/mcp/proposals/approve /api/mcp/proposals/reject',
    'MCP-Agenten und Inhaltsfreigabe', 'Agent, Token, Berechtigungen und konkreter Vorschlag', '/integrations/mcp', 'frontend/src/features/mcp/mcp-agents.tsx',
    'Freigabe bindet redigierten Inhalt, Scope und aktuellen Preflight; die Ausführung prüft ihre Autorität erneut.', { contractTests: ['tests/test_mcp_control_plane.js', 'tests/test_ui_change_reviews.js'] }),
  group('/api/telegram-viewer /api/telegram-viewer/settings /api/telegram-viewer/token /api/telegram-viewer/service-token/rotate /api/telegram-viewer/test',
    'Telegram Viewer', 'Getrennter Bot, Viewer-Service und Benachrichtigungsregeln', '/integrations/telegram-viewer', 'frontend/src/features/telegram-viewer/telegram-viewer.tsx',
    'Einstellungen speichern, Tokens einmalig übernehmen und ausdrücklich einen Testversand anfordern.', { contractTests: ['tests/test_telegram_viewer_api.js'] }),
  group('/api/trading/channel-risk /api/trading/routes', 'Legacy-Routen und Kanalrisiko', 'Legacy-Kanal; bestehende Intents ohne Workflowpfad', '/risk/adaptive?kind=legacy', 'frontend/src/features/risk-analytics/adaptive-risk.tsx',
    'Originale lesen und Policy als Workflowentwurf übernehmen.', { contractTests: ['tests/test_workflow_migration.js', 'tests/test_ui_adaptive_risk.js'], boundary: 'Legacy-Schreibverträge bleiben für Kompatibilität erhalten. Neue UI-Konfiguration verwendet gepinnte Workflow-Ressourcen; parallele Legacy-Änderungen würden deren Herkunft nicht verändern.' }),
  group('/api/import', 'Legacy-Signalimport', 'Historische Betriebsdaten', '/signals/processed', 'frontend/src/features/signals/signals-page.tsx',
    'Kompatibilitätsimport vorhandener Signale; keine neue KI-Ausführung.', { contractTests: ['tests/test_web_server.js'], boundary: 'Engineering-Kompatibilität für vorbereitete historische Importdaten. Die UI verwendet den einzeln geprüften Test-/Signalweg; kein beliebiger Datenimport als Handelscommand.' }),
  group('/api/ui/deployment', 'Deployment und Browserbuild', 'Gelesene Dienstinstanz und tatsächlich geladener Browserbuild', '/operations/deployment', 'frontend/src/features/operations/deployment.tsx',
    'Betriebssystem- und cgroup-Beobachtungen, interner Listener und getrennt deklarierte Hostwerte. Kein freier Hostcommand.', { contractTests: ['tests/test_web_server.js'] }),
  group('/api/ui/search /api/ui/capabilities /api/ui/parameters', 'Verzeichnis und Suche', 'Metadaten und berechtigte Ansichten', '/operations/capabilities', 'frontend/src/features/operations/capabilities.tsx',
    'Lesende Orientierung. Angezeigte Voraussetzungen ersetzen keine serverseitige Freigabe.', { contractTests: ['tests/test_ui_register.js'] }),
];

export function uiCapabilityGroup(route: string): Group {
  const pathname = route.slice(route.indexOf(' ') + 1);
  const entry = UI_CAPABILITY_GROUPS.find(item => item.paths.includes(pathname));
  if (!entry) throw new Error(`Unmapped operator route: ${route}`);
  return entry;
}

export interface UiCapabilityContext {
  role: string; recovery: boolean; canMutate: boolean; mutationInProgress: boolean;
  startupPhase: string | null; startupReason: string | null;
}
function currentBlockers(entry: typeof UI_ROUTE_INVENTORY[number], state: UiCapabilityContext): string[] {
  const blockers: string[] = [];
  if (entry.role === 'admin' && state.role !== 'admin') blockers.push('Administratorrolle erforderlich.');
  if (state.recovery && !entry.recoveryAllowed) blockers.push('Im Recovery-Modus nicht zugelassen.');
  const write = !entry.route.startsWith('GET ');
  const repair = state.recovery && ['POST /api/config', 'POST /api/secrets', 'POST /api/runtime-settings'].includes(entry.route);
  if (write && !state.canMutate && !repair && entry.route !== 'POST /api/restart') blockers.push(`Startfreigabe fehlt: ${state.startupReason ?? state.startupPhase ?? 'unbekannt'}`);
  if (write && state.mutationInProgress) blockers.push('Ein anderer Steuerungsbefehl läuft.');
  return blockers;
}
export function uiCapabilities(query: URLSearchParams, state: UiCapabilityContext) {
  const limit = Number(query.get('limit') ?? 50);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('Invalid capability page size.');
  const area = query.get('area') ?? '';
  if (area && !['cockpit', 'trading', 'workflows', 'signals', 'risk', 'integrations', 'operations', 'recovery'].includes(area)) throw new Error('Invalid capability area.');
  const filter = filterFingerprint({ catalog: UI_ROUTE_INVENTORY, area, limit, role: state.role });
  const cursor = decodeUiCursor(query.get('cursor'), filter); const observedAt = cursor?.observedAt ?? Date.now();
  const selected = UI_ROUTE_INVENTORY.filter(entry => !area || uiCapabilityGroup(entry.route).href.split('/')[1].split('?')[0] === area);
  const offset = cursor ? Number(cursor.id) : 0;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > selected.length) throw new Error('Invalid capability cursor.');
  const entries = selected.slice(offset, offset + limit).map(entry => {
    const { paths: _paths, ...mapping } = uiCapabilityGroup(entry.route);
    return { ...entry, ...mapping, currentBlockers: currentBlockers(entry, state),
      authority: 'Hinweis zum beobachteten Zustand. Rolle, Audit, Frische, Identität, Eigentum und Versionsbindung werden am tatsächlichen Command erneut geprüft.' };
  });
  const hasMore = selected.length > offset + limit;
  return { contractVersion: 1, observedAt, currentObservedAt: Date.now(), entries, total: selected.length, hasMore,
    nextCursor: hasMore ? encodeUiCursor({ version: 1, filter, observedAt, createdAt: 0, id: String(offset + limit) }) : null };
}
