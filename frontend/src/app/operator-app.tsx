import { lazy, Suspense, useCallback, useState } from "react";
import { Link, useLocation } from "@/lib/navigation";
import { jsonRequest } from "@/lib/api";
import { usePoll } from "@/shared/api/use-poll";
import { Logo } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { OperationsWorkspace } from "@/app/workflow/operations-panel";
import type { ExchangeCatalog, TradingSnapshot } from "@/app/workflow/types";
import { OPERATOR_AREAS, operatorTab } from "./operator-routes";
import { TradeDetail } from "@/features/trades/trade-detail";
import { PaperLab } from "@/features/trades/paper-lab";
import { AccountDetail } from "@/features/accounts/account-detail";
import { AccountsPage } from '@/features/accounts/accounts-page';
import { TradingList, type TradingListKind } from "@/features/trades/trading-list";
import { IngressDetail, SignalsPage } from "@/features/signals/signals-page";
import { SignalOriginal } from '@/features/signals/signal-original';
import { OperatorReadOnlyContext } from "@/shared/api/operator-session";
import { JobsPage } from '@/features/operations/jobs-page';
import { BackupsPage } from '@/features/operations/backups-page';
import { TestLab } from '@/features/workflows/test-lab';
import { ProposalDetail } from '@/features/mcp/proposal-detail';
import { WorkflowLibrary, WorkflowObject } from '@/features/workflows/workflow-library';
import { GlobalSearch } from '@/shared/components/global-search';
import { TelegramSettings } from '@/features/signals/telegram-settings';
import { ModelLibrary } from '@/features/workflows/model-library';
import { RiskAccounts, RiskAccountEvidence } from '@/features/risk-analytics/account-evidence';
import { AdaptiveRiskPage } from '@/features/risk-analytics/adaptive-risk';
import { CapabilitiesPage } from '@/features/operations/capabilities';
import { DeploymentEvidence } from '@/features/operations/deployment';

const WorkflowBuilder = lazy(() => import("@/app/workflow/workflow-builder").then((module) => ({ default: module.WorkflowBuilder })));
export function OperatorApp() {
  const { pathname } = useLocation();
  const tab = operatorTab(pathname);
  const area = OPERATOR_AREAS.find((item) => item.id === pathname.split("/")[1]);
  const [session, setSession] = useState<any>(null);
  const [trading, setTrading] = useState<TradingSnapshot | null>(null);
  const [status, setStatus] = useState<Record<string, any> | null>(null);
  const [catalog, setCatalog] = useState<ExchangeCatalog | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [refresh, setRefresh] = useState(0);
  const [globalState, setGlobalState] = useState<any>(null);
  const readGlobalState = useCallback((signal: AbortSignal) => jsonRequest('/api/trading?view=overview', { signal }), []);
  usePoll(readGlobalState, value => { setGlobalState({ ...value, readAt: Date.now() }); setErrors(previous => ({ ...previous, runtime: '' })); }, failure => setErrors(previous => ({ ...previous, runtime: failure.message })), 5000, refresh);
  const globalRuntime = globalState?.overview?.runtime;
  const readSession = useCallback((signal: AbortSignal) => jsonRequest("/api/recovery", { signal }), []);
  usePoll(readSession, (value) => { setSession(value); setErrors((previous) => ({ ...previous, connection: "" })); }, (reason) => setErrors((previous) => ({ ...previous, connection: reason.message })));
  const needsTrading = tab === "overview";
  const needsStatus = tab === "overview" || tab === "system";
  const needsCatalog = tab === "accounts" || tab === "analytics" || tab === "system";
  const readPage = useCallback(async (signal: AbortSignal) => {
    const requests = [
      ...(needsTrading ? [{ name: "trading", url: "/api/trading?view=cockpit" }] : []),
      ...(needsStatus ? [{ name: "status", url: "/api/status" }] : []),
      ...(needsCatalog ? [{ name: "catalog", url: "/api/exchanges/catalog" }] : []),
    ];
    return Promise.all(requests.map(async (request) => {
      try { return { name: request.name, value: await jsonRequest(request.url, { signal }), error: "" }; }
      catch (error) { return { name: request.name, value: null, error: error instanceof Error ? error.message : String(error) }; }
    }));
  }, [needsTrading, needsStatus, needsCatalog]);
  usePoll(readPage, (results) => {
    for (const result of results) {
      setErrors((previous) => ({ ...previous, [result.name]: result.error }));
      if (result.error) continue;
      if (result.name === "trading") setTrading(result.value);
      if (result.name === "status") setStatus(result.value);
      if (result.name === "catalog") setCatalog(result.value);
    }
  }, (error) => setErrors((previous) => ({ ...previous, page: error.message })), 5000, refresh);
  const onRefresh = useCallback(async () => { setRefresh((value) => value + 1); }, []);
  const tradeMatch = /^\/trading\/trades\/([^/]+)$/.exec(pathname);
  const accountMatch = /^\/trading\/accounts\/([^/]+)$/.exec(pathname);
  const ingressMatch = /^\/signals\/messages\/([^/]+)$/.exec(pathname);
  const originalMatch = /^\/signals\/(cache|processed)\/([^/]+)$/.exec(pathname);
  const listMatch = /^\/trading\/(positions|orders|operations|incidents|reconciliations|risk-events)$/.exec(pathname);
  const jobMatch = /^\/operations\/jobs(?:\/([^/]+))?$/.exec(pathname);
  const backupMatch = /^\/operations\/backups(?:\/([^/]+))?$/.exec(pathname);
  const proposalMatch = /^\/integrations\/mcp\/proposals\/([^/]+)$/.exec(pathname);
  const resourceMatch = /^\/workflows\/resources(?:\/([^/]+)(?:\/versions\/([^/]+))?)?$/.exec(pathname);
  const workflowMatch = /^\/workflows\/(paths|revisions)(?:\/([^/]+))?$/.exec(pathname);
  const modelMatch = /^\/workflows\/models\/(strategy|schema|contract)(?:\/([^/]+))?$/.exec(pathname);
  const riskMatch = /^\/risk\/accounts(?:\/([^/]+))?$/.exec(pathname);
  const readOnly = session?.session?.role !== "admin";
  const decodeId = (value: string) => { try { return decodeURIComponent(value); } catch { return value; } };
  const filteredTrading = needsTrading ? trading : null;
  return <OperatorReadOnlyContext.Provider value={readOnly}><div className="min-h-screen bg-background text-foreground">
    <header className="border-b p-4 flex flex-wrap items-center justify-between gap-3"><Link to="/cockpit" aria-label="TSX Core Cockpit"><Logo variant="full" size={36} /></Link>
      <div className="text-sm"><p>{session?.session?.actorId ?? "Identität wird geprüft"} · {session?.session?.role ?? "unbekannte Rolle"}</p><p>Backend {session?.backendVersion ?? "unbekannt"} · UI {__UI_VERSION__} · {errors.connection ? "Verbindung gestört" : session ? "verbunden" : "Verbindung wird geprüft"}</p></div><GlobalSearch /><ThemeToggle />
    </header>
    <nav aria-label="Hauptbereiche" className="grid grid-cols-2 gap-2 border-b p-3 sm:grid-cols-4 xl:grid-cols-7">{OPERATOR_AREAS.map((item) => <Link tabIndex={0} key={item.id} to={item.links[0][0]} aria-current={area?.id === item.id ? "page" : undefined} className={`min-h-11 flex items-center px-3 py-2 border ${area?.id === item.id ? "bg-muted font-semibold" : "border-transparent"}`}>{item.label}</Link>)}</nav>
    <nav aria-label="Unterbereiche" className="flex flex-wrap gap-3 px-4 py-3">{area?.links.map(([path, label]) => <Link key={path} to={path} aria-current={pathname === path ? "page" : undefined} className="min-h-11 px-2 py-3 underline-offset-4 hover:underline">{label}</Link>)}<Link to="/recovery" className="ml-auto min-h-11 py-3">Recovery</Link></nav>
    <div className="px-4 text-sm"><p>Neue Entries: {globalRuntime?.executionEnabled === true ? "global erlaubt" : globalRuntime ? "global pausiert" : "unbekannt"} · Live-Erlaubnis: {globalRuntime?.liveTradingEnabled === true ? "global erlaubt; Kontomodus separat prüfen" : globalRuntime ? "global gesperrt" : "unbekannt"}. Bestehende Exposition und Schutz sind gesonderte Nachweise. {globalState && `Globalen Zustand gelesen ${new Date(globalState.readAt).toLocaleTimeString('de-DE')}.`}</p></div>
    <div className="p-4" role={pathname === "/workflows/builder" ? undefined : "main"}>{Object.entries(errors).filter(([, error]) => error).map(([source, error]) => <p key={source} role="alert">{source}: {error} · Vorhandene Daten können veraltet sein.</p>)}
      {session?.active && <p role="alert">Recovery ist aktiv. <Link to="/recovery">Reparatureinstieg öffnen</Link></p>}
      {tradeMatch ? <TradeDetail key={tradeMatch[1]} intentId={decodeId(tradeMatch[1])} readOnly={session?.session?.role !== "admin"} />
        : accountMatch ? <><AccountDetail key={accountMatch[1]} id={decodeId(accountMatch[1])} readOnly={readOnly} /><AccountsPage catalog={catalog} accountId={decodeId(accountMatch[1])} onRefresh={onRefresh} /></>
        : pathname === '/trading/accounts' ? <AccountsPage catalog={catalog} onRefresh={onRefresh} />
        : listMatch ? <TradingList kind={listMatch[1] as TradingListKind} />
        : jobMatch ? <JobsPage key={pathname} id={jobMatch[1] ? decodeId(jobMatch[1]) : undefined} />
        : backupMatch ? <BackupsPage key={pathname} name={backupMatch[1] ? decodeId(backupMatch[1]) : undefined} />
        : proposalMatch ? <ProposalDetail key={pathname} id={decodeId(proposalMatch[1])} />
        : resourceMatch ? resourceMatch[2] ? <WorkflowObject key={pathname} kind="resources" resourceId={decodeId(resourceMatch[1])} id={decodeId(resourceMatch[2])} /> : <WorkflowLibrary key={pathname} kind="resources" resourceId={resourceMatch[1] ? decodeId(resourceMatch[1]) : undefined} />
        : workflowMatch ? workflowMatch[2] ? <WorkflowObject key={pathname} kind={workflowMatch[1] as 'paths' | 'revisions'} id={decodeId(workflowMatch[2])} /> : <WorkflowLibrary key={pathname} kind={workflowMatch[1] as 'paths' | 'revisions'} />
        : modelMatch ? <ModelLibrary key={pathname} kind={modelMatch[1] as 'strategy' | 'schema' | 'contract'} id={modelMatch[2] ? decodeId(modelMatch[2]) : undefined} />
        : riskMatch ? riskMatch[1] ? <RiskAccountEvidence key={pathname} accountId={decodeId(riskMatch[1])} /> : <RiskAccounts />
        : pathname === '/risk/adaptive' ? <AdaptiveRiskPage />
        : pathname === '/operations/capabilities' ? <CapabilitiesPage />
        : pathname === '/operations/deployment' ? <DeploymentEvidence />
        : ingressMatch ? <IngressDetail key={ingressMatch[1]} id={decodeId(ingressMatch[1])} />
        : originalMatch ? <SignalOriginal key={pathname} id={decodeId(originalMatch[2])} kind={originalMatch[1] === 'cache' ? 'messages' : 'processed'} />
        : ['/signals/messages', '/signals/processed', '/signals/outbox', '/signals/cache'].includes(pathname) ? <SignalsPage kind={pathname === "/signals/messages" ? "ingress" : pathname === "/signals/outbox" ? "outbox" : pathname === '/signals/cache' ? 'messages' : "processed"} readOnly={readOnly} />
        : pathname === "/trading/paper" ? <PaperLab readOnly={readOnly} />
        : pathname === '/signals/telegram' ? <TelegramSettings />
        : pathname === '/workflows/tests' || pathname === '/signals/ai' ? <TestLab />
        : pathname === "/workflows/builder" ? <Suspense fallback={<p>Workflows werden geladen …</p>}><WorkflowBuilder embedded /></Suspense>
          : tab ? <OperationsWorkspace key={pathname} trading={filteredTrading} catalog={catalog} systemStatus={status} onRefresh={onRefresh} initialTab={tab} availableTabs={[tab]} ariaLabel={area?.label ?? "Betrieb"} filtersOpen />
            : <section><h1>Seite nicht gefunden</h1><p>Die Objektadresse wird von dieser UI-Version nicht unterstützt.</p><Link to="/cockpit">Cockpit öffnen</Link></section>}
    </div>
  </div></OperatorReadOnlyContext.Provider>;
}
