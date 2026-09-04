import { moneyDisplay, type DisplayMoney } from "./money-display";

export function MoneyAmount(props: DisplayMoney) {
  const text = moneyDisplay(props);
  return <span title={text.detail} aria-label={`${text.label}. ${text.detail}`} style={{ overflowWrap: "anywhere" }}>
    {text.label}
  </span>;
}

export function MoneySummaryAmount({ summary }: { summary?: Record<string, any> | null }) {
  return <span>
    <MoneyAmount value={summary?.realizedPnlValue} amount={summary?.realizedPnl} currency={summary?.reportingCurrency} status={summary?.accountingStatus} />
    {summary?.accountingStatus === "unresolved" && Object.entries(summary.valuedSubtotalValuesByCurrency || {}).map(([currency, value]) =>
      <small key={currency} style={{ display: "block" }}>Bewerteter Teilbetrag: <MoneyAmount value={value} currency={currency} /></small>)}
  </span>;
}
