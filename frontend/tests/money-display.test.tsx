import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MoneyAmount, MoneySummaryAmount } from "@/app/workflow/money-amount";
import { moneyChartGroups, moneyDisplay } from "@/app/workflow/money-display";

const rational = { lower: "-9.975062344139650873", upper: "-9.975062344139650872", exact: { numerator: "-4000", denominator: "401" },
  decimal: null, precision: "exact_rational", terms: 1 };
const native = { lower: "2", upper: "2", exact: { numerator: "2", denominator: "1" }, decimal: "2", precision: "exact_decimal", terms: 1 };
afterEach(cleanup);
describe("monetary evidence presentation", () => {
  it("shows valued rational money with its exact accessible fraction, never as an open trade", () => {
    render(<MoneyAmount value={rational} amount={null} currency="USD" status="complete" />);
    expect(screen.getByText("≈ −9,975062 USD")).toHaveAttribute("title", "Exakt: -4000/401 USD");
    expect(screen.queryByText("offen")).not.toBeInTheDocument();
  });
  it("does not turn a tiny negative result into displayed zero", () => {
    const value = { ...rational, lower: "-0.000000000000000998", upper: "-0.000000000000000997",
      exact: { numerator: "-1", denominator: "1002500000000000" } };
    expect(moneyDisplay({ value, currency: "USD" }).label).toBe("negativ (< 0,000001) USD");
  });
  it("shows conservative bounds separately and respects unresolved source state", () => {
    const bounded = { ...rational, lower: "-0.000000000000000001", upper: "0.000000000000000001", exact: null, precision: "bounded", terms: 2 };
    expect(moneyDisplay({ value: bounded, currency: "USDC" }).label).toBe("[-0,000000000000000001; 0,000000000000000001] USDC (Grenzen)");
    expect(moneyDisplay({ value: native, amount: "100", status: "unresolved" }).label).toBe("Bewertung ungeklärt");
    expect(moneyDisplay({ amount: null }).label).toBe("Bewertung ungeklärt");
  });
  it("keeps exact native decimals and rejects malformed fractional presentation", () => {
    expect(moneyDisplay({ amount: "4.990000000000000001", currency: "USDT" }).label).toBe("4,990000000000000001 USDT");
    expect(moneyDisplay({ value: { ...rational, exact: { numerator: "1", denominator: "0" } }, amount: "1" }).uncertain).toBe(true);
  });
  it("rejects contradictory exact aliases and bounds instead of showing a loss as zero", () => {
    for (const value of [
      { ...rational, precision: "exact_decimal", decimal: "0" },
      { ...native, exact: { numerator: "-1", denominator: "1002500000000000000" } },
      { ...rational, lower: "0", upper: "1" },
      { ...native, lower: "3", upper: "2" },
      { ...native, exact: { numerator: 2, denominator: "1" } },
    ]) {
      expect(moneyDisplay({ value, amount: "0", currency: "USD", status: "complete" }).label).toBe("Bewertung ungeklärt");
      expect(moneyChartGroups([{ realizedPnlValue: value, reportingCurrency: "USD", accountingStatus: "complete" }])).toEqual([]);
    }
  });
  it("never charts a not-proven or missing valuation status as complete", () => {
    for (const accountingStatus of ["not_proven", "incomplete", "unresolved", undefined]) {
      expect(moneyChartGroups([{ realizedPnlValue: native, reportingCurrency: "USD", accountingStatus }])).toEqual([]);
    }
  });
  it("labels per-currency valued subtotals without claiming a complete combined total", () => {
    render(<MoneySummaryAmount summary={{ accountingStatus: "unresolved", realizedPnl: null, realizedPnlValue: null,
      valuedSubtotalValuesByCurrency: { USD: rational, USDC: native } }} />);
    expect(screen.getByText("Bewertung ungeklärt")).toBeInTheDocument();
    expect(screen.getAllByText(/Bewerteter Teilbetrag:/)).toHaveLength(2);
    expect(screen.getByText("≈ −9,975062 USD")).toHaveAttribute("title", "Exakt: -4000/401 USD");
    expect(screen.getByText("2 USDC")).toHaveAttribute("title", "Exakt: 2/1 USDC");
  });
  it("separates graph currencies, omits uncertainty and retains negative coordinates", () => {
    const groups = moneyChartGroups([
      { id: "a", reportingCurrency: "USD", realizedPnlValue: rational, accountingStatus: "complete" },
      { id: "b", reportingCurrency: "USDC", realizedPnlValue: native, accountingStatus: "complete" },
      { id: "c", reportingCurrency: "USD", realizedPnlValue: native, accountingStatus: "unresolved" },
      { id: "d", reportingCurrency: null, realizedPnlValue: native, accountingStatus: "complete" },
      { id: "e", reportingCurrency: "USD", realizedPnlValue: { ...rational, exact: null, precision: "bounded" } },
    ]);
    expect(groups.map(group => group.currency)).toEqual(["USD", "USDC"]);
    expect(groups[0].points).toHaveLength(1);
    expect(groups[0].points[0].chartPnl).toBeLessThan(0);
    expect(groups[1].points[0].chartPnl).toBe(2);
  });
});
