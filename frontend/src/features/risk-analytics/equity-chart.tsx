import { Empty, time } from "@/shared/components/operator-primitives";
import { useMemo } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

type EquityChartSeries = {
  accountId: string;
  dataKey: string;
  name: string;
};

export type EquityChartGroup = {
  currency: string;
  series: EquityChartSeries[];
  points: Array<Record<string, number | string>>;
};

function equityObservationGroup(point: Record<string, any>): string | null {
  if (typeof point.reportingCurrency !== "string" || !/^[A-Z0-9]{2,12}$/.test(point.reportingCurrency)
    || !point.accountingSource || !["paper", "testnet", "live"].includes(point.mode)) return null;
  return `${point.reportingCurrency} (${point.mode})`;
}

export function buildEquityChartGroups(
  inputPoints: Array<Record<string, any>>,
  inputAccounts: Array<Record<string, any>>,
): EquityChartGroup[] {
  const accounts = new Map(inputAccounts.map((account) => [String(account.id), account]));
  const grouped = new Map<string, Map<string, Array<{ observedAt: number; equity: number; exact: string }>>>();
  for (const point of inputPoints) {
    const observedAt = Number(point.observedAt);
    const equity = Number(point.equity);
    if (!Number.isSafeInteger(observedAt) || observedAt <= 0 || typeof point.equity !== "string" || !Number.isFinite(equity)) continue;
    const accountId = point.accountId == null ? "aggregate" : String(point.accountId);
    const currency = equityObservationGroup(point);
    if (!currency) continue;
    const byAccount = grouped.get(currency) ?? new Map();
    byAccount.set(accountId, [...(byAccount.get(accountId) ?? []), { observedAt, equity, exact: point.equity }]);
    grouped.set(currency, byAccount);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, byAccount]) => {
      const accountIds = [...byAccount.keys()].sort((left, right) => {
        const leftName = String(accounts.get(left)?.name ?? left);
        const rightName = String(accounts.get(right)?.name ?? right);
        return leftName.localeCompare(rightName, "de-DE");
      });
      const series = accountIds.map((accountId, index) => ({
        accountId,
        dataKey: `account_${index}`,
        name: String(accounts.get(accountId)?.name ?? (accountId === "aggregate" ? "Equity" : accountId)),
      }));
      const rows = new Map<number, Record<string, number | string>>();
      for (const item of series) {
        for (const point of byAccount.get(item.accountId) ?? []) {
          const row = rows.get(point.observedAt) ?? { observedAt: point.observedAt };
          row[item.dataKey] = point.equity;
          row[`${item.dataKey}Exact`] = point.exact;
          rows.set(point.observedAt, row);
        }
      }
      return {
        currency,
        series,
        points: [...rows.values()].sort((left, right) => Number(left.observedAt) - Number(right.observedAt)),
      };
    });
}

const EQUITY_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];

export function EquityChart({
  points,
  accounts,
  emptyText,
  metric = 'equity',
}: Readonly<{
  points: Array<Record<string, any>>;
  accounts: Array<Record<string, any>>;
  emptyText: string;
  metric?: 'equity' | 'drawdown';
}>) {
  const groups = useMemo(() => buildEquityChartGroups(metric === 'equity' ? points : points.filter(point => point.drawdownPercent != null)
    .map(point => ({ ...point, equity: String(point.drawdownPercent) })), accounts), [accounts, points, metric]);
  const unknown = points.filter(point => !equityObservationGroup(point)).length;
  if (groups.length === 0) return <Empty text={unknown ? `${unknown} Beobachtungen ohne Währungs-, Modus- oder Quellenbeleg; keine vergleichbare Kurve verfügbar.` : emptyText} />;
  return (
    <div className="equity-chart-groups">
      <p>{metric === 'equity' ? 'Kurven zeigen näherungsweise einzelne Beobachtungen, keine lückenlose Überwachung. Tooltips zeigen den originalen Betrag.' : 'Drawdown vom beobachteten Höchststand innerhalb dieser Auswahl. Näherungsweise Prozentwerte je Konto, Originalwährung und Modus; kein belegter Allzeithöchststand.'} {unknown > 0 && `${unknown} Beobachtungen ohne Währungs-, Modus- oder Quellenbeleg sind ausgeschlossen.`}</p>
      {groups.map((group) => (
        <div className="equity-chart-group" key={group.currency}>
          <div className="equity-chart-legend">
            <strong>{group.currency}</strong>
            {group.series.map((series, index) => (
              <span key={series.accountId}>
                <i style={{ background: EQUITY_COLORS[index % EQUITY_COLORS.length] }} />
                {series.name}
              </span>
            ))}
          </div>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={group.points}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="observedAt" tickFormatter={(value) => new Date(value).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })} minTickGap={28} />
              <YAxis width={64} domain={["auto", "auto"]} />
              <Tooltip labelFormatter={(value) => time(value)} formatter={(_value, _name, item) => { const exactKey = `${item.dataKey}Exact`; return `${item.payload?.[exactKey] ?? "unbekannt"} ${metric === 'drawdown' ? '% (näherungsweise)' : group.currency}`; }} />
              {group.series.map((series, index) => (
                <Line
                  key={series.accountId}
                  type="monotone"
                  dataKey={series.dataKey}
                  name={series.name}
                  connectNulls={false}
                  dot={{ r: 2 }}
                  stroke={EQUITY_COLORS[index % EQUITY_COLORS.length]}
                  strokeWidth={2}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      ))}
    </div>
  );
}
