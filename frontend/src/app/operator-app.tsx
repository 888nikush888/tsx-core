import { useCallback, useState } from "react";
import { Link, useLocation } from "@/lib/navigation";
import { jsonRequest } from "@/lib/api";
import { usePoll } from "@/shared/api/use-poll";
import { Logo } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import type { ExchangeCatalog, TradingSnapshot } from "@/app/workflow/types";
import { OPERATOR_AREAS, operatorTab } from "./operator-routes";
import { OperatorReadOnlyContext } from "@/shared/api/operator-session";
import { GlobalSearch } from '@/shared/components/global-search';

import { OperatorPage } from "./operator-page";
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
  const readOnly = session?.session?.role !== "admin";
  const Content = pathname === "/workflows/builder" ? "div" : "main";
  const filteredTrading = needsTrading ? trading : null;
  const livePermission = () => {
    if (globalRuntime?.liveTradingEnabled === true) {
      return "global erlaubt; Kontomodus separat prüfen";
    }
    if (globalRuntime) {
      return "global gesperrt";
    }
    return "unbekannt";
  };
  const entryPermission = () => {
    if (globalRuntime?.executionEnabled === true) {
      return "global erlaubt";
    }
    if (globalRuntime) {
      return "global pausiert";
    }
    return "unbekannt";
  };
  const connectionStatus = () => {
    if (errors.connection) {
      return "Verbindung gestört";
    }
    if (session) {
      return "verbunden";
    }
    return "Verbindung wird geprüft";
  };
  return <OperatorReadOnlyContext.Provider value={readOnly}><div className="min-h-screen bg-background text-foreground">
    <header className="border-b p-4 flex flex-wrap items-center justify-between gap-3"><Link to="/cockpit" aria-label="TSX Core Cockpit"><Logo variant="full" size={36} /></Link>
      <div className="text-sm"><p>{session?.session?.actorId ?? "Identität wird geprüft"} · {session?.session?.role ?? "unbekannte Rolle"}</p><p>Backend {session?.backendVersion ?? "unbekannt"} · UI {__UI_VERSION__} · {connectionStatus()}</p></div><GlobalSearch /><ThemeToggle />
    </header>
    <nav aria-label="Hauptbereiche" className="grid grid-cols-2 gap-2 border-b p-3 sm:grid-cols-4 xl:grid-cols-7">{OPERATOR_AREAS.map((item) => <Link tabIndex={0} key={item.id} to={item.links[0][0]} aria-current={area?.id === item.id ? "page" : undefined} className={`min-h-11 flex items-center px-3 py-2 border ${area?.id === item.id ? "bg-muted font-semibold" : "border-transparent"}`}>{item.label}</Link>)}</nav>
    <nav aria-label="Unterbereiche" className="flex flex-wrap gap-3 px-4 py-3">{area?.links.map(([path, label]) => <Link key={path} to={path} aria-current={pathname === path ? "page" : undefined} className="min-h-11 px-2 py-3 underline-offset-4 hover:underline">{label}</Link>)}<Link to="/recovery" className="ml-auto min-h-11 py-3">Recovery</Link></nav>
    <div className="px-4 text-sm"><p>Neue Entries: {entryPermission()} · Live-Erlaubnis: {livePermission()}. Bestehende Exposition und Schutz sind gesonderte Nachweise. {globalState && `Globalen Zustand gelesen ${new Date(globalState.readAt).toLocaleTimeString('de-DE')}.`}</p></div>
    <Content className="p-4">{Object.entries(errors).filter(([, error]) => error).map(([source, error]) => <p key={source} role="alert">{source}: {error} · Vorhandene Daten können veraltet sein.</p>)}
      {session?.active && <p role="alert">Recovery ist aktiv. <Link to="/recovery">Reparatureinstieg öffnen</Link></p>}
      <OperatorPage pathname={pathname} readOnly={readOnly} trading={filteredTrading} catalog={catalog} status={status} onRefresh={onRefresh} areaLabel={area?.label} />
    </Content>
  </div></OperatorReadOnlyContext.Provider>;
}
