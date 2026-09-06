import { Mcp } from "@/features/mcp/mcp-agents";
import { TelegramViewer } from "@/features/telegram-viewer/telegram-viewer";
import { useEffect, useMemo, useState } from "react";
import { Activity, BarChart3, Bot, DatabaseBackup, Gauge, Landmark, Send, ServerCog, Terminal } from "lucide-react";
import { BackupsPage } from "@/features/operations/backups-page";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ExchangeCatalog, TradingSnapshot } from "@/app/workflow/types";
import { useOperatorReadOnly } from "@/shared/api/operator-session";
import { JournalPage } from "@/features/journal/journal-page";
import { Overview } from '@/features/cockpit/overview';
import { Accounts } from '@/features/accounts/accounts';
import { Analytics } from '@/features/risk-analytics/analytics';
import { Logs } from '@/features/operations/logs';
import { System } from '@/features/operations/system';
export { buildJournalQueryString, normalizeJournalSymbol } from '@/features/journal/query';
export { resolveDisplayedLeverage } from '@/features/trades/plan-display';
export { buildEquityChartGroups, type EquityChartGroup } from '@/features/risk-analytics/equity-chart';

export type OperationTab =
  | "overview"
  | "accounts"
  | "journal"
  | "analytics"
  | "logs"
  | "backups"
  | "mcp"
  | "telegram-viewer"
  | "system";

const TABS: Array<{ id: OperationTab; label: string; description: string; icon: typeof Activity }> =
  [
    { id: "overview", label: "Live", description: "Gates und Laufzeit", icon: Activity },
    { id: "accounts", label: "Konten", description: "Börsen und Schutz", icon: Landmark },
    { id: "journal", label: "Journal", description: "Trades und Prüfung", icon: Gauge },
    { id: "analytics", label: "Analyse", description: "Leistung und Latenz", icon: BarChart3 },
    { id: "logs", label: "Logs", description: "Live-Diagnose", icon: Terminal },
    { id: "backups", label: "Backups", description: "Sicherung und Restore", icon: DatabaseBackup },
    { id: "mcp", label: "MCP", description: "Agenten und Rechte", icon: Bot },
    { id: "telegram-viewer", label: "Telegram Viewer", description: "Nur lesender Bot", icon: Send },
    { id: "system", label: "System", description: "Zugriff und Wartung", icon: ServerCog },
  ];

const OPERATION_TABS = new Map(TABS.map((tab) => [tab.id, tab]));

type OperationsWorkspaceProps = {
  trading: TradingSnapshot | null;
  catalog: ExchangeCatalog | null;
  systemStatus: Record<string, any> | null;
  onRefresh: () => Promise<void>;
  initialTab?: OperationTab;
  availableTabs?: OperationTab[];
  ariaLabel?: string;
  title?: string;
  description?: string;
  filtersOpen?: boolean;
  onOpenIncidents?: () => void;
};

export function OperationsWorkspace({
  trading,
  catalog,
  systemStatus,
  onRefresh,
  initialTab = "overview",
  availableTabs = TABS.map((item) => item.id),
  ariaLabel = "Betrieb",
  title,
  description,
  filtersOpen,
  onOpenIncidents,
}: Readonly<OperationsWorkspaceProps>) {
  const readOnly = useOperatorReadOnly();
  const [tab, setTab] = useState<OperationTab>(initialTab);
  useEffect(() => {
    if (!availableTabs.includes(tab)) setTab(initialTab);
  }, [availableTabs, initialTab, tab]);
  const content = useMemo(() => {
    if (tab === "overview")
      return (
        <Overview
          trading={trading}
          systemStatus={systemStatus}
          onRefresh={onRefresh}
          onOpenIncidents={onOpenIncidents}
        />
      );
    if (tab === "accounts")
      return (
        <Accounts trading={trading} catalog={catalog} onRefresh={onRefresh} />
      );
    if (tab === "journal") return <JournalPage trading={trading} onRefresh={onRefresh} />;
    if (tab === "analytics") return <Analytics trading={trading} catalog={catalog} filtersOpen={filtersOpen} />;
    if (tab === "logs") return <Logs />;
    if (tab === "backups") return <BackupsPage />;
    if (tab === "mcp") return <Mcp />;
    if (tab === "telegram-viewer") return <TelegramViewer />;
    return (
      <System
        catalog={catalog}
        systemStatus={systemStatus}
        onRefresh={onRefresh}
      />
    );
  }, [catalog, filtersOpen, onOpenIncidents, onRefresh, systemStatus, tab, trading]);

  return (
    <section className="operations-workspace" aria-label={ariaLabel}>
      {(title || description) && (
        <header className="operations-workspace-header">
          <div>
            <Badge variant="secondary">TSX Core</Badge>
            {title && <h2>{title}</h2>}
            {description && <p>{description}</p>}
          </div>
        </header>
      )}
      {availableTabs.length > 1 && (
        <Tabs
          value={tab}
          onValueChange={(value) => setTab(value as OperationTab)}
          className="operations-tabs"
        >
          <TabsList
            variant="line"
            className="operations-tab-list"
            aria-label="Betriebsbereiche"
          >
            {availableTabs.map((tabId) => OPERATION_TABS.get(tabId)).filter(Boolean).map((item) => {
              if (!item) return null;
              const Icon = item.icon;
              return (
                <TabsTrigger key={item.id} value={item.id}>
                  <Icon />
                  <span><strong>{item.label}</strong><small>{item.description}</small></span>
                </TabsTrigger>
              );
            })}
          </TabsList>
        </Tabs>
      )}
      <div className="operations-content">
        {readOnly && <p role="status">Lesender Zugriff. Änderungen erfordern die Administratorrolle.</p>}
        {readOnly && !["journal", "analytics", "logs", "backups"].includes(tab) ? <fieldset disabled className="min-w-0 border-0 p-0">{content}</fieldset> : content}
      </div>
    </section>
  );
}
