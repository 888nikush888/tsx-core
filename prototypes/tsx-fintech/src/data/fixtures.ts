// Deterministische Demo-Fixtures. Keine echten Daten, keine Backend-Aufrufe.
export interface DemoAccount { id: string; name: string; exchange: string; mode: "paper" | "live"; enabled: boolean; equity: number; currency: string; positions: number; stateVersion: number }
export interface DemoPosition { id: string; accountId: string; symbol: string; side: "LONG" | "SHORT"; size: number; entry: number; mark: number; pnl: number; leverage: number }
export interface DemoOrder { id: string; accountId: string; symbol: string; side: string; type: string; qty: number; price: number | null; status: "offen" | "teilweise" | "ausgefuehrt" | "storniert"; created: string }
export interface DemoIntent { id: string; quelle: string; symbol: string; seite: string; status: "wartend" | "beobachtet" | "abgeschlossen" | "blockiert"; created: string; notiz: string }
export interface DemoWorkflow { id: string; name: string; status: "aktiv" | "entwurf" | "pausiert"; revision: number; updated: string }
export interface DemoSignal { id: string; kanal: string; text: string; zeit: string; parser: string; vertrauen: number }
export interface DemoProposal { id: string; agent: string; aktion: string; status: "wartend" | "genehmigt" | "abgelehnt"; created: string; detail: string }
export interface DemoJob { id: string; name: string; status: "ok" | "laeuft" | "fehler"; last: string }
export interface DemoBackup { id: string; ziel: string; zeit: string; groesse: string; status: "geprueft" | "offen" }
export interface DemoLog { zeit: string; ebene: "info" | "warnung" | "fehler"; quelle: string; text: string }

export const accounts: DemoAccount[] = [
  { id: "paper-1", name: "Paper-Labor", exchange: "Hyperliquid", mode: "paper", enabled: true, equity: 10250.40, currency: "USDC", positions: 2, stateVersion: 7 },
  { id: "live-1", name: "Live-Testkonto", exchange: "Kraken Futures", mode: "live", enabled: false, equity: 5000.00, currency: "EUR", positions: 0, stateVersion: 3 },
]
export const positions: DemoPosition[] = [
  { id: "pos-1", accountId: "paper-1", symbol: "BTC-PERP", side: "LONG", size: 0.12, entry: 97410.0, mark: 98120.5, pnl: 85.26, leverage: 3 },
  { id: "pos-2", accountId: "paper-1", symbol: "ETH-PERP", side: "SHORT", size: 1.4, entry: 3420.0, mark: 3398.2, pnl: 30.52, leverage: 2 },
]
export const orders: DemoOrder[] = [
  { id: "ord-101", accountId: "paper-1", symbol: "BTC-PERP", side: "Kauf", type: "Limit", qty: 0.05, price: 97900.0, status: "offen", created: "2026-09-26T14:02:00" },
  { id: "ord-102", accountId: "paper-1", symbol: "ETH-PERP", side: "Verkauf", type: "Stop", qty: 0.6, price: 3410.0, status: "teilweise", created: "2026-09-26T15:44:00" },
  { id: "ord-103", accountId: "paper-1", symbol: "SOL-PERP", side: "Kauf", type: "Market", qty: 4.0, price: null, status: "ausgefuehrt", created: "2026-09-25T10:12:00" },
]
export const intents: DemoIntent[] = [
  { id: "int-9001", quelle: "Telegram #trend", symbol: "BTC-PERP", seite: "LONG", status: "beobachtet", created: "2026-09-26T14:00:00", notiz: "Sorgfaeltig pruefen" },
  { id: "int-9002", quelle: "KI-Modell v3", symbol: "ETH-PERP", seite: "SHORT", status: "abgeschlossen", created: "2026-09-26T09:30:00", notiz: "Ziel erreicht" },
  { id: "int-9003", quelle: "Telegram #news", symbol: "SOL-PERP", seite: "LONG", status: "blockiert", created: "2026-09-26T08:05:00", notiz: "Kill-Switch aktiv" },
]
export const workflows: DemoWorkflow[] = [
  { id: "wf-trend", name: "Trendfolge Standard", status: "aktiv", revision: 12, updated: "2026-09-24T18:00:00" },
  { id: "wf-absicherung", name: "Absicherung Abend", status: "entwurf", revision: 3, updated: "2026-09-26T11:20:00" },
  { id: "wf-nacht", name: "Nachtpause", status: "pausiert", revision: 8, updated: "2026-09-20T22:10:00" },
]
export const graphNodes = [
  { id: "start", kind: "Eingang", label: "Signal-Eingang", x: 40, y: 80 },
  { id: "filter", kind: "Filter", label: "Liquiditaetsfilter", x: 280, y: 80 },
  { id: "risiko", kind: "Risiko", label: "Positionspruefung", x: 520, y: 80 },
  { id: "order", kind: "Order", label: "Order aufgeben", x: 760, y: 80 },
  { id: "stopp", kind: "Schutz", label: "Schutzstopp", x: 760, y: 240 },
]
export const graphEdges = [
  { id: "e1", from: "start", to: "filter" },
  { id: "e2", from: "filter", to: "risiko" },
  { id: "e3", from: "risiko", to: "order" },
  { id: "e4", from: "order", to: "stopp" },
]
export const signals: DemoSignal[] = [
  { id: "sig-1", kanal: "#trend", text: "BTC ueber 98.000, Volumen steigt", zeit: "2026-09-26T14:01:00", parser: "Standard v2", vertrauen: 0.82 },
  { id: "sig-2", kanal: "#news", text: "ETH-Upgrade bestaetigt", zeit: "2026-09-26T09:31:00", parser: "Standard v2", vertrauen: 0.64 },
]
export const proposals: DemoProposal[] = [
  { id: "prop-41", agent: "risiko-waechter", aktion: "Hebel auf 2x begrenzen", status: "wartend", created: "2026-09-26T16:02:00", detail: "Betrifft paper-1, alle Symbole." },
  { id: "prop-40", agent: "journal-assistent", aktion: "Notizen zusammenfassen", status: "genehmigt", created: "2026-09-26T10:15:00", detail: "Nur lesend, keine Orders." },
]
export const jobs: DemoJob[] = [
  { id: "job-backup", name: "Backup-Pruefung", status: "ok", last: "2026-09-26T06:00:00" },
  { id: "job-reconcile", name: "Positionsabgleich", status: "laeuft", last: "2026-09-26T16:30:00" },
  { id: "job-alarm", name: "Alarmversand", status: "fehler", last: "2026-09-26T16:28:00" },
]
export const backups: DemoBackup[] = [
  { id: "b2-0926", ziel: "B2 Tresor", zeit: "2026-09-26T06:00:00", groesse: "184 MB", status: "geprueft" },
  { id: "drv-0926", ziel: "Zweitanbieter (verschluesselt)", zeit: "2026-09-26T06:20:00", groesse: "184 MB", status: "offen" },
]
export const logs: DemoLog[] = [
  { zeit: "2026-09-26T16:31:02", ebene: "info", quelle: "routing", text: "Intent int-9001 an Beobachtung uebergeben." },
  { zeit: "2026-09-26T16:28:44", ebene: "fehler", quelle: "alarm", text: "Zustellung an Empfaenger fehlgeschlagen, Wiederholung geplant." },
  { zeit: "2026-09-26T16:20:10", ebene: "warnung", quelle: "risiko", text: "Hebelgrenze bei ETH-PERP fast erreicht." },
]
export const riskLimits = [
  { name: "Maximales Tagesminus", wert: "-2,0 %", zustand: "ok" },
  { name: "Positionsobergrenze", wert: "3 gleichzeitig", zustand: "ok" },
  { name: "Hebelobergrenze", wert: "3x", zustand: "warnung" },
  { name: "Notfallschalter", wert: "scharf", zustand: "ok" },
]
export const catalogParams = [
  { path: "account.name", label: "Kontoname", typ: "Text", bereich: "Trading", route: "/trading/konten", art: "Autosave" },
  { path: "account.maxConcurrentPositions", label: "Maximale Positionen", typ: "Zahl", bereich: "Trading", route: "/trading/konten", art: "Atomar" },
  { path: "strategy.risk.dailyLossLimit", label: "Tagesverlustgrenze", typ: "Prozent", bereich: "Risiko & Analyse", route: "/risiko/limits", art: "Entwurf/Freigabe" },
  { path: "viewer.enabled", label: "Viewer aktiv", typ: "Schalter", bereich: "Signale & Integrationen", route: "/signale/viewer", art: "Autosave" },
  { path: "mcp.agent.permissions", label: "Agentenrechte", typ: "Auswahl", bereich: "Signale & Integrationen", route: "/signale/mcp", art: "Entwurf/Freigabe" },
  { path: "secrets.exchangeCredentials", label: "Boersenzugang", typ: "Secret", bereich: "Einstellungen", route: "/einstellungen/zugriff", art: "Befehl" },
  { path: "runtime.enterpriseMode", label: "Betriebsmodus", typ: "Schalter", bereich: "Betrieb", route: "/betrieb/zustand", art: "Autosave" },
  { path: "deployment.hostPorts", label: "Host-Ports", typ: "Text", bereich: "Betrieb", route: "/betrieb/deployment", art: "Befehl" },
]
