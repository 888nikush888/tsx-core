import { Metric, Empty, time } from "@/shared/components/operator-primitives";
import { useCallback, useMemo, useState } from "react";
import { jsonRequest } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { AnalyticsResponse, ExecutionAnalytics, ExchangeCatalog, TradingSnapshot } from "@/app/workflow/types";
import { MoneyAmount, MoneySummaryAmount } from "@/app/workflow/money-amount";
import { moneyChartGroups, moneyDisplay } from "@/app/workflow/money-display";
import { usePoll } from "@/shared/api/use-poll";
import { analyticsQuery } from "@/features/risk-analytics/query";
import { EquityChart } from '@/features/risk-analytics/equity-chart';
import { Link, useSearchParams } from '@/lib/navigation';
import { AccountFilter } from '@/features/accounts/account-filter';
import { JOURNAL_INTENT_STATUSES } from '../../../../src/ui_contracts';

function metricNumber(value: unknown, digits = 2): string {
  if (value === null || value === undefined || value === "") return "–";
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? new Intl.NumberFormat("de-DE", {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      }).format(parsed)
    : "–";
}

function duration(value: unknown): string {
  if (value === null || value === undefined || value === '') return '–';
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "–";
  return parsed < 1_000
    ? `${Math.round(parsed)} ms`
    : `${metricNumber(parsed / 1_000)} s`;
}

type AnalyticsRange = "24h" | "7d" | "30d" | "90d" | "all" | "custom";

function analyticsFilterValues(query: URLSearchParams) {
  const selectedRange = query.get('range') ?? '30d';
  const range: AnalyticsRange = ['24h', '7d', '30d', '90d', 'all', 'custom'].includes(selectedRange) ? selectedRange as AnalyticsRange : '30d';
  return {
    range, customFrom: query.get('customFrom') ?? '', customUntil: query.get('customUntil') ?? '', channelId: query.get('channelId') ?? '',
    accountId: query.get('accountId') ?? '', exchange: query.get('exchange') ?? '', mode: query.get('mode') ?? '', status: query.get('status') ?? '',
  };
}

function analyticsDataFor(analytics: AnalyticsResponse | null, trading: TradingSnapshot | null) {
  const channels = analytics?.performance?.channels || [];
  const exchanges = analytics?.performance?.exchanges || [];
  const equity = analytics?.performance?.equity || [];
  const adaptiveStates = trading?.workflowAdaptiveRisk?.states || [];
  const evaluations = trading?.workflowAdaptiveRisk?.evaluations || [];
  const executionIncomplete = analytics?.execution?.coverage?.complete === false;
  const execution: ExecutionAnalytics = executionIncomplete ? {} : analytics?.execution || {};
  const fallback = analytics?.fallback || {};
  const totalMoney = analytics?.performance?.total;
  const channelMoneyCharts = moneyChartGroups(channels);
  const closedTrades = channels.reduce((total, item) => total + Number(item.closedTrades || 0), 0);
  const drawdowns = equity.filter((point) => point.drawdownPercent != null && Number.isFinite(Number(point.drawdownPercent))).map((point) => Number(point.drawdownPercent));
  const peakDrawdown = drawdowns.length ? Math.max(...drawdowns) : null;
  const funnel = Object.entries(execution.funnel || {}).map(([name, value]) => ({ name: name.replaceAll("_", " "), value: Number(value) }));
  return { channels, exchanges, equity, adaptiveStates, evaluations, executionIncomplete, execution, fallback, totalMoney, channelMoneyCharts, closedTrades, peakDrawdown, funnel };
}

function AnalyticsFilterBar({ filtersOpen, range, setRange, customFrom, setCustomFrom, customUntil, setCustomUntil, channelId, setChannelId, channelOptions, accountId, setAccountId, exchange, setExchange, exchangeOptions, mode, setMode, status, setStatus }: Readonly<{
  filtersOpen?: boolean; range: AnalyticsRange; setRange: (value: AnalyticsRange) => void; customFrom: string; setCustomFrom: (value: string) => void;
  customUntil: string; setCustomUntil: (value: string) => void; channelId: string; setChannelId: (value: string) => void; channelOptions: string[];
  accountId: string; setAccountId: (value: string) => void; exchange: string; setExchange: (value: string) => void; exchangeOptions: [string, string][];
  mode: string; setMode: (value: string) => void; status: string; setStatus: (value: string) => void;
}>) {
  return (
    filtersOpen && (
        <section className="operations-card analytics-filterbar" aria-label="Analysefilter">
        <label>
          <span>Zeitraum</span>
          <select value={range} onChange={(event) => setRange(event.target.value as AnalyticsRange)}>
            <option value="24h">24 Stunden</option>
            <option value="7d">7 Tage</option>
            <option value="30d">30 Tage</option>
            <option value="90d">90 Tage</option>
            <option value="all">Gesamt</option>
            <option value="custom">Benutzerdefiniert</option>
          </select>
        </label>
        {range === "custom" && (
          <>
            <label><span>Von</span><Input type="datetime-local" value={customFrom} onChange={(event) => setCustomFrom(event.target.value)} /></label>
            <label><span>Bis</span><Input type="datetime-local" value={customUntil} onChange={(event) => setCustomUntil(event.target.value)} /></label>
          </>
        )}
        <label><span>Kanal</span><Input list="analytics-channels" value={channelId} onChange={(event) => setChannelId(event.target.value)} placeholder="Alle Kanäle oder exakte Kanal-ID" maxLength={128} /><datalist id="analytics-channels">{channelOptions.map(id => <option key={id} value={id} />)}</datalist></label>
        <AccountFilter value={accountId} onChange={setAccountId} />
        <label><span>Börse</span><select value={exchange} onChange={(event) => setExchange(event.target.value)}><option value="">Alle Börsen</option>{exchangeOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
        <label><span>Modus</span><select value={mode} onChange={(event) => setMode(event.target.value)}><option value="">Alle Modi</option><option value="paper">Paper</option><option value="testnet">Testnet</option><option value="live">Live</option></select></label>
        <label><span>Intentstatus</span><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">Alle Intentstatus</option>{JOURNAL_INTENT_STATUSES.map(value => <option key={value}>{value}</option>)}</select></label>
      </section>
      )
  );
}

function AnalyticsNotices({ error, analytics, status, executionIncomplete }: Readonly<{ error: string; analytics: AnalyticsResponse | null; status: string; executionIncomplete: boolean }>) {
  return (
    <>
      {error && <div role="alert" className="builder-error">{error}</div>}
      {!analytics && <p><output>Für diese Filter ist noch kein Analyseergebnis bestätigt.</output></p>}
      {status && <p>Der Statusfilter bezieht sich auf Intents. Ereignisse und Fallbackkandidaten ohne zugeordneten Intentstatus sind dabei ausgeschlossen.</p>}
      {executionIncomplete && <p role="alert">Mehr als 20.000 passende Ausführungsereignisse. Funnel und Latenz bleiben ohne vollständigen Nachweis ausgeblendet; Zeitraum oder Dimensionen weiter eingrenzen.</p>}
    </>
  );
}

function AnalyticsMetrics({ analytics, totalMoney, closedTrades, peakDrawdown, execution, fallback }: Readonly<{
  analytics: AnalyticsResponse | null; totalMoney: AnalyticsResponse["performance"]["total"]; closedTrades: number; peakDrawdown: number | null;
  execution: ExecutionAnalytics; fallback: AnalyticsResponse["fallback"];
}>) {
  return (
      <div className="operations-metrics">
        <Metric label="Realisierter PnL" value={<MoneySummaryAmount summary={totalMoney} />} />
        <Metric label="Geschlossene Trades" value={analytics ? closedTrades : '–'} />
        <Metric
          label="Max. Drawdown %"
          value={metricNumber(peakDrawdown)}
          danger={peakDrawdown !== null && peakDrawdown > 5}
        />
        <div className="operation-metric">
          <strong>
            {duration(execution.latencyMs?.signalToSubmit?.p95)}
          </strong>
          <span>Signal → Submit p95</span>
        </div>
        <Metric label="Fallback-Ketten" value={fallback.runs ?? '–'} />
        <Metric label="Fallback gewählt" value={fallback.selected ?? '–'} />
        <Metric label="Kette ausgeschöpft" value={fallback.exhausted ?? '–'} danger={(fallback.exhausted || 0) > 0} />
      </div>
  );
}

function AnalyticsCharts({ equity, trading, channelMoneyCharts, funnel }: Readonly<{
  equity: AnalyticsResponse["performance"]["equity"]; trading: TradingSnapshot | null; channelMoneyCharts: ReturnType<typeof moneyChartGroups>; funnel: Array<{ name: string; value: number }>;
}>) {
  return (
      <div className="analytics-chart-grid">
        <section className="operations-card analytics-chart">
          <h3>Equity-Verlauf</h3>
          <EquityChart
            points={equity}
            accounts={trading?.accounts || []}
            emptyText="Für diese Auswahl liegen keine Equity-Punkte vor."
          />
        </section>
        <section className="operations-card analytics-chart">
          <h3>Drawdown</h3>
          <EquityChart points={equity} accounts={trading?.accounts ?? []} metric="drawdown" emptyText="Für diese Auswahl liegt kein belegter Drawdown vor." />
        </section>
        <section className="operations-card analytics-chart">
          <h3>Realisierter PnL je Kanal</h3>
          {channelMoneyCharts.length ? channelMoneyCharts.map((group) => (
            <div key={group.currency}>
            <h4>{group.currency} · Diagramm näherungsweise</h4>
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={group.points}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="id" minTickGap={18} />
                <YAxis width={64} />
                <Tooltip formatter={(_value, _name, item) => moneyDisplay({ value: item.payload?.realizedPnlValue,
                  currency: group.currency, status: item.payload?.accountingStatus }).label} />
                <Bar dataKey="chartPnl" fill="var(--chart-2)" radius={0} />
              </BarChart>
            </ResponsiveContainer>
            </div>
          )) : <Empty text="Keine eindeutig bewerteten Kanalbeträge für dieses Diagramm." />}
          <small>Währungen bleiben getrennt. Ungeklärte Beträge und reine Wertgrenzen erscheinen nur in der Tabelle, nicht als Nullbalken.</small>
        </section>
        <section className="operations-card analytics-chart">
          <h3>Ausführungs-Funnel</h3>
          {funnel.some((item) => item.value > 0) ? (
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={funnel} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" allowDecimals={false} />
                <YAxis type="category" dataKey="name" width={110} />
                <Tooltip />
                <Bar dataKey="value" fill="var(--chart-3)" radius={0} />
              </BarChart>
            </ResponsiveContainer>
          ) : <Empty text="Keine Ausführungsereignisse in dieser Auswahl." />}
        </section>
      </div>
  );
}

function ChannelPerformanceSection({ channels }: Readonly<{ channels: AnalyticsResponse["performance"]["channels"] }>) {
  return (
      <section className="operations-card">
        <h3>Kanalperformance</h3>
        <div
          className="analytics-table"
          role="table"
          aria-label="Kanalperformance"
        >
          <div className="analytics-row heading" role="row">
            <span>Kanal</span>
            <span>Trades</span>
            <span>W / L</span>
            <span>Win Rate</span>
            <span>PnL</span>
            <span>Slippage</span>
          </div>
          {channels.map((item) => (
            <div className="analytics-row" role="row" key={item.id}>
              <strong>{item.id}</strong>
              <span>{item.closedTrades}</span>
              <span>
                {item.wins} / {item.losses}
              </span>
              <span>{metricNumber(item.winRatePercent, 1)} %</span>
              <MoneySummaryAmount summary={item} />
              <span>
                {item.averageEntrySlippageBps == null
                  ? "–"
                  : `${metricNumber(item.averageEntrySlippageBps)} bps`}
              </span>
            </div>
          ))}
          {channels.length === 0 && (
            <Empty text="Noch keine abgeschlossenen Trades für eine Kanalbewertung." />
          )}
        </div>
      </section>
  );
}

function ExchangeComparisonSection({ exchanges }: Readonly<{ exchanges: AnalyticsResponse["performance"]["exchanges"] }>) {
  return (
      <section className="operations-card">
        <h3>Börsenvergleich</h3>
        {exchanges.map((item) => (
          <div className="system-line" key={item.id}>
            <span>
              {item.id} · {item.completedIntents || 0}/{item.intents || 0}{" "}
              abgeschlossen
            </span>
            <strong>
              {item.averageEntrySlippageBps == null
                ? "keine Fills"
                : `${metricNumber(item.averageEntrySlippageBps)} bps`}
            </strong>
          </div>
        ))}
        {exchanges.length === 0 && (
          <Empty text="Noch keine Börsenausführungen." />
        )}
      </section>
  );
}

function FallbackAccountSection({ fallback }: Readonly<{ fallback: AnalyticsResponse["fallback"] }>) {
  return (
      <section className="operations-card">
        <h3>Fallback-Auswahl je Börsenkonto</h3>
        {(fallback.byAccount || []).map((item) => (
          <div className="system-line" key={item.accountId}>
            <span>{item.accountId} · {item.exchange}/{item.mode}</span>
            <strong>{item.selected} gewählt · {item.unavailable} übersprungen · {item.attempts} Versuche</strong>
          </div>
        ))}
        {!(fallback.byAccount || []).length && (
          <Empty text="Für den gewählten Zeitraum liegen keine Fallback-Versuche vor." />
        )}
      </section>
  );
}

function AdaptiveStatesSection({ adaptiveStates }: Readonly<{ adaptiveStates: TradingSnapshot["workflowAdaptiveRisk"]["states"] }>) {
  return (
      <section className="operations-card">
        <h3>Aktives adaptives Risiko je Pfad</h3>
        {adaptiveStates.map((item) => (
          <div className="adaptive-row" key={item.stateKey}>
            <div>
              <strong>
                {item.channelId} → {item.accountId}
              </strong>
              <small>
                {item.resourceName} · zuletzt {time(item.updatedAt)}
              </small>
            </div>
            <span
              className={`state-badge ${item.blocked ? "danger" : "healthy"}`}
            >
              {item.blocked
                ? "gesperrt"
                : `Stufe ${(item.lockedTier ?? item.currentTier) + 1}`}
            </span>
          </div>
        ))}
        {adaptiveStates.length === 0 && (
          <Link to="/risk/adaptive">Aktive Policen mit vollständiger Seitenauswahl und Originalbelegen öffnen</Link>
        )}
      </section>
  );
}

function EvaluationsSection({ evaluations, channelId, accountId }: Readonly<{ evaluations: TradingSnapshot["workflowAdaptiveRisk"]["evaluations"]; channelId: string; accountId: string }>) {
  return (
      <section className="operations-card">
        <h3>Letzte adaptive Bewertungen</h3>
        {evaluations.filter((item) => (!channelId || item.channelId === channelId) && (!accountId || item.accountId === accountId)).slice(0, 30).map((item) => (
          <div className="adaptive-row" key={item.id}>
            <div>
              <strong>
                {item.channelId} · {item.action}
              </strong>
              <small>
                {item.reason} · {item.closedTrades} Trades · PnL{" "}
                <MoneyAmount value={item.realizedPnlValue} amount={item.realizedPnl} currency={item.reportingCurrency}
                  status={item.invalidatedAt ? "unresolved" : item.accountingStatus} />
              </small>
            </div>
            <span>
              Stufe {item.previousTier} → {item.appliedTier}
            </span>
          </div>
        ))}
        {evaluations.length === 0 && (
          <Link to="/risk/adaptive?kind=evaluations">Adaptive Originalbewertungen seitenweise lesen</Link>
        )}
      </section>
  );
}

type ExpectancyInput = { winRate: string; averageWin: string; averageLoss: string };
function ExpectancySection({ expectancy, setExpectancy, expectancyValue }: Readonly<{ expectancy: ExpectancyInput; setExpectancy: (value: ExpectancyInput | ((previous: ExpectancyInput) => ExpectancyInput)) => void; expectancyValue: number }>) {
  return (
    <section className="operations-card">
      <h3>Erwartungswert-Rechner</h3>
        <div className="expectancy-grid">
          <label><span>Trefferquote %</span><Input type="number" min="0" max="100" value={expectancy.winRate} onChange={(event) => setExpectancy((value) => ({ ...value, winRate: event.target.value }))} /></label>
          <label><span>Ø Gewinn (R)</span><Input type="number" min="0" step="0.1" value={expectancy.averageWin} onChange={(event) => setExpectancy((value) => ({ ...value, averageWin: event.target.value }))} /></label>
          <label><span>Ø Verlust (R)</span><Input type="number" min="0" step="0.1" value={expectancy.averageLoss} onChange={(event) => setExpectancy((value) => ({ ...value, averageLoss: event.target.value }))} /></label>
          <div className={`expectancy-result ${expectancyValue < 0 ? "danger" : "healthy"}`}><strong>{metricNumber(expectancyValue, 3)} R</strong><span>Erwartungswert je Trade</span></div>
        </div>
    </section>
  );
}

export function Analytics({
  trading,
  catalog,
  filtersOpen,
}: Readonly<{
  trading: TradingSnapshot | null;
  catalog: ExchangeCatalog | null;
  filtersOpen?: boolean;
}>) {
  const [query, setQuery] = useSearchParams();
  const { range, customFrom, customUntil, channelId, accountId, exchange, mode, status } = analyticsFilterValues(query);
  const updateFilter = (key: string, value: string) => setQuery(current => {
    if (value) current.set(key, value); else current.delete(key);
    return current;
  });
  const setRange = (value: AnalyticsRange) => updateFilter('range', value);
  const setCustomFrom = (value: string) => updateFilter('customFrom', value);
  const setCustomUntil = (value: string) => updateFilter('customUntil', value);
  const setChannelId = (value: string) => updateFilter('channelId', value);
  const setAccountId = (value: string) => updateFilter('accountId', value);
  const setExchange = (value: string) => updateFilter('exchange', value);
  const setMode = (value: string) => updateFilter('mode', value);
  const setStatus = (value: string) => updateFilter('status', value);
  const [analyticsResponse, setAnalyticsResponse] = useState<{ context: string; value: AnalyticsResponse } | null>(null);
  const analyticsContext = JSON.stringify([range, customFrom, customUntil, channelId, accountId, exchange, mode, status]);
  const analytics = analyticsResponse?.context === analyticsContext ? analyticsResponse.value : null;
  const [error, setError] = useState("");
  const [expectancy, setExpectancy] = useState({
    winRate: "50",
    averageWin: "2",
    averageLoss: "1",
  });
  const readAnalytics = useCallback(async (signal: AbortSignal) => {
    const query = analyticsQuery({ range, customFrom, customUntil, channelId, accountId, exchange, mode, status }, Date.now());
    return { context: analyticsContext, value: await jsonRequest(`/api/trading/analytics?${query}`, { signal }) };
  }, [range, customFrom, customUntil, channelId, accountId, exchange, mode, status, analyticsContext]);
  usePoll(readAnalytics, (value) => { setAnalyticsResponse(value); setError(""); }, (reason) => setError(reason.message));
  const fallbackSkipReasons = [
    ["SYMBOL_UNAVAILABLE", "Pair fehlt"],
    ["MAX_CONCURRENT_POSITIONS", "Account voll"],
    ["SYMBOL_ALREADY_OWNED", "Pair bereits offen"],
  ] as const;
  const { channels, exchanges, equity, adaptiveStates, evaluations, executionIncomplete, execution, fallback, totalMoney, channelMoneyCharts, closedTrades, peakDrawdown, funnel } = analyticsDataFor(analytics, trading);
  const expectancyValue =
    (Number(expectancy.winRate) / 100) * Number(expectancy.averageWin) -
    (1 - Number(expectancy.winRate) / 100) * Number(expectancy.averageLoss);
  const channelOptions = useMemo(
    () => [...new Set<string>((analytics?.performance?.channels || []).map((item) => String(item.id)))],
    [analytics?.performance?.channels],
  );
  const exchangeOptions = useMemo(() => {
    const labels = new Map<string, string>();
    for (const entry of catalog?.exchanges || []) labels.set(entry.id, entry.name);
    for (const account of trading?.accounts || []) {
      if (!labels.has(account.exchange)) labels.set(account.exchange, account.exchange);
    }
    for (const item of trading?.channelAnalytics?.exchanges || []) {
      const id = String(item.id || item.exchange || "");
      if (id && !labels.has(id)) labels.set(id, id);
    }
    return [...labels].sort((left, right) => left[1].localeCompare(right[1]));
  }, [catalog, trading?.accounts, trading?.channelAnalytics?.exchanges]);
  return (
    <div className="operations-stack">
      <AnalyticsFilterBar filtersOpen={filtersOpen} range={range} setRange={setRange} customFrom={customFrom} setCustomFrom={setCustomFrom} customUntil={customUntil} setCustomUntil={setCustomUntil} channelId={channelId} setChannelId={setChannelId} channelOptions={channelOptions} accountId={accountId} setAccountId={setAccountId} exchange={exchange} setExchange={setExchange} exchangeOptions={exchangeOptions} mode={mode} setMode={setMode} status={status} setStatus={setStatus} />
      <AnalyticsNotices error={error} analytics={analytics} status={status} executionIncomplete={executionIncomplete} />
      <AnalyticsMetrics analytics={analytics} totalMoney={totalMoney} closedTrades={closedTrades} peakDrawdown={peakDrawdown} execution={execution} fallback={fallback} />
      <AnalyticsCharts equity={equity} trading={trading} channelMoneyCharts={channelMoneyCharts} funnel={funnel} />
      <ChannelPerformanceSection channels={channels} />
      <ExchangeComparisonSection exchanges={exchanges} />
      <section className="operations-card">
        <h3>Fallback-Übersprünge</h3>
        {fallbackSkipReasons.map(([reason, label]) => (
          <div className="system-line" key={reason}>
            <span>{label}</span>
            <strong>{fallback.skippedByReason?.[reason] || 0}</strong>
          </div>
        ))}
      </section>
      <FallbackAccountSection fallback={fallback} />
      <AdaptiveStatesSection adaptiveStates={adaptiveStates} />
      <EvaluationsSection evaluations={evaluations} channelId={channelId} accountId={accountId} />
      <ExpectancySection expectancy={expectancy} setExpectancy={setExpectancy} expectancyValue={expectancyValue} />
    </div>
  );
}
