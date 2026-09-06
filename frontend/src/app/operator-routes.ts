import type { OperationTab } from "@/app/workflow/operations-panel";

export const OPERATOR_AREAS = [
  { id: "cockpit", label: "Cockpit", links: [["/cockpit", "Betriebszustand"]] },
  { id: "trading", label: "Trading", links: [["/trading/accounts", "Konten"], ["/trading/positions", "Positionen"], ["/trading/orders", "Orders"], ["/trading/operations", "Börsenoperationen"], ["/trading/journal", "Journal & Intents"], ["/trading/paper", "Paper-Labor"]] },
  { id: "workflows", label: "Workflows", links: [["/workflows/builder", "Builder"], ["/workflows/paths", "Pfadliste"], ["/workflows/resources", "Bibliothek"], ["/workflows/models/strategy", "Modelle"], ["/workflows/revisions", "Revisionen"], ["/workflows/tests", "Testlabor"]] },
  { id: "signals", label: "Signale & Versand", links: [["/signals/messages", "Eingang & Alben"], ["/signals/processed", "Parserergebnisse"], ["/signals/outbox", "Outbox"], ["/signals/telegram", "Telegram & Queue"], ["/signals/ai?mode=ai", "KI-Test"]] },
  { id: "risk", label: "Risiko & Analyse", links: [["/risk/analytics", "Risiko & Performance"], ["/risk/accounts", "Kontorisiko & Historie"], ["/risk/adaptive", "Adaptive Policen"]] },
  { id: "integrations", label: "Integrationen", links: [["/integrations/mcp", "MCP & Freigaben"], ["/integrations/telegram-viewer", "Telegram Viewer"]] },
  { id: "operations", label: "Betrieb & Sicherheit", links: [["/operations/settings", "Einstellungen"], ["/operations/backups", "Backups"], ["/operations/jobs", "Wartungsaufträge"], ["/operations/logs", "Diagnose & Logs"], ["/operations/deployment", "Deployment"], ["/operations/capabilities", "Aktionen & Parameter"]] },
] as const;

export function operatorTab(pathname: string): OperationTab | null {
  if (pathname === "/cockpit") return "overview";
  if (/^\/trading\/accounts(?:\/[^/]+)?$/.test(pathname)) return "accounts";
  if (pathname === "/trading/journal") return "journal";
  if (pathname === "/risk/analytics") return "analytics";
  if (/^\/integrations\/mcp(?:\/proposals\/[^/]+)?$/.test(pathname)) return "mcp";
  if (pathname === "/integrations/telegram-viewer") return "telegram-viewer";
  if (pathname === "/operations/backups") return "backups";
  if (pathname === "/operations/logs") return "logs";
  if (pathname === "/operations/settings") return "system";
  return null;
}
