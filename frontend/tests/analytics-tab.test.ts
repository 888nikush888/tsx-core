import { describe, expect, it } from "vitest"

import {
  buildExecutionFunnel,
  calculateExpectation,
  formatAnalyticsDuration,
} from "@/app/dashboard/components/analytics-tab"

describe("Analytics contracts", () => {
  it("calculates expectancy and a linear trade projection", () => {
    expect(calculateExpectation({
      winRate: "50",
      averageWinR: "1.5",
      averageLossR: "1",
      riskPercent: "1",
      trades: "100",
    })).toMatchObject({
      expectancyR: 0.25,
      expectancyPercent: 0.25,
      projectedPercent: 25,
      breakEvenWinRate: 40,
    })
  })

  it("keeps the execution funnel in operational order", () => {
    const funnel = buildExecutionFunnel({ signal_received: 10, first_fill: 4 })
    expect(funnel[0]).toMatchObject({ id: "signal_received", count: 10 })
    expect(funnel.find(item => item.id === "first_fill")?.count).toBe(4)
    expect(funnel.at(-1)?.id).toBe("fully_filled")
  })

  it("formats millisecond and second latency without inventing missing values", () => {
    expect(formatAnalyticsDuration(425)).toBe("425 ms")
    expect(formatAnalyticsDuration(1_500)).toBe("1,50 s")
    expect(formatAnalyticsDuration(null)).toBe("–")
  })
})
