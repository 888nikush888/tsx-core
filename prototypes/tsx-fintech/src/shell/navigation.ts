export interface NavEintrag { route: string; label: string }
export interface NavBereich { id: string; titel: string; eintraege: NavEintrag[] }

export const NAVIGATION: NavBereich[] = [
  { id: "uebersicht", titel: "Uebersicht", eintraege: [{ route: "/uebersicht", label: "Uebersicht" }] },
  { id: "trading", titel: "Trading", eintraege: [
    { route: "/trading/konten", label: "Konten" },
    { route: "/trading/positionen", label: "Positionen" },
    { route: "/trading/orders", label: "Orders" },
    { route: "/trading/ausfuehrungen", label: "Ausfuehrungen" },
    { route: "/trading/journal", label: "Journal & Intents" },
    { route: "/trading/paper", label: "Paper-Labor" },
  ] },
  { id: "automationen", titel: "Automationen", eintraege: [
    { route: "/automationen/workflows", label: "Workflows" },
    { route: "/automationen/builder", label: "Builder" },
    { route: "/automationen/pfade", label: "Pfadliste" },
    { route: "/automationen/ressourcen", label: "Bibliothek" },
    { route: "/automationen/modelle", label: "Modelle" },
    { route: "/automationen/revisionen", label: "Revisionen" },
    { route: "/automationen/tests", label: "Testlabor" },
  ] },
  { id: "signale", titel: "Signale & Integrationen", eintraege: [
    { route: "/signale/eingang", label: "Eingang & Alben" },
    { route: "/signale/parser", label: "Parserergebnisse" },
    { route: "/signale/outbox", label: "Outbox" },
    { route: "/signale/telegram", label: "Telegram & Queue" },
    { route: "/signale/ki-test", label: "KI-Test" },
    { route: "/signale/mcp", label: "MCP & Freigaben" },
    { route: "/signale/viewer", label: "Telegram Viewer" },
  ] },
  { id: "risiko", titel: "Risiko & Analyse", eintraege: [
    { route: "/risiko/limits", label: "Limits & Exposition" },
    { route: "/risiko/konten", label: "Kontorisiko & Historie" },
    { route: "/risiko/adaptiv", label: "Adaptive Policen" },
  ] },
  { id: "betrieb", titel: "Betrieb", eintraege: [
    { route: "/betrieb/zustand", label: "Zustand" },
    { route: "/betrieb/jobs", label: "Wartungsauftraege" },
    { route: "/betrieb/logs", label: "Diagnose & Logs" },
    { route: "/betrieb/backups", label: "Backups" },
    { route: "/betrieb/recovery", label: "Recovery" },
    { route: "/betrieb/deployment", label: "Deployment" },
  ] },
  { id: "einstellungen", titel: "Einstellungen", eintraege: [
    { route: "/einstellungen/katalog", label: "Parameterkatalog" },
    { route: "/einstellungen/zugriff", label: "Zugriff & Secrets" },
    { route: "/einstellungen/system", label: "System" },
  ] },
];
