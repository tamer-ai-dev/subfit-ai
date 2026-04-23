import { describe, it, expect } from "vitest";
import {
  normalizeModel,
  verdict5h,
  findBestFit,
  costOn,
  computeSubscriptionStats,
} from "../subfit-ai.ts";

describe("normalizeModel", () => {
  it("buckets Opus wire names (4, 4-5, 4-7) to claude-opus-4", () => {
    for (const w of ["claude-opus-4", "claude-opus-4-5", "claude-opus-4-7"]) {
      expect(normalizeModel(w)).toEqual({ key: "claude-opus-4", matched: true });
    }
  });

  it("buckets Sonnet wire names (4, 4-6) to claude-sonnet-4", () => {
    for (const w of ["claude-sonnet-4", "claude-sonnet-4-6"]) {
      expect(normalizeModel(w)).toEqual({ key: "claude-sonnet-4", matched: true });
    }
  });

  it("buckets Haiku wire names including dated snapshots to claude-haiku-4-5", () => {
    for (const w of ["claude-haiku-4-5", "claude-haiku-4-5-20251001"]) {
      expect(normalizeModel(w)).toEqual({ key: "claude-haiku-4-5", matched: true });
    }
  });

  it("flags unknown strings with matched:false and defaults to opus bucket", () => {
    expect(normalizeModel("gpt-future-x")).toEqual({ key: "claude-opus-4", matched: false });
    expect(normalizeModel(undefined)).toEqual({ key: "claude-opus-4", matched: false });
  });

  it("is case-insensitive", () => {
    expect(normalizeModel("Claude-Opus-4-7")).toEqual({ key: "claude-opus-4", matched: true });
  });
});

describe("verdict5h", () => {
  it("returns unlimited verdict for null range", () => {
    expect(verdict5h(999, null)).toMatch(/^unlimited/);
  });

  it("returns FITS comfortably when avg is well below low bound", () => {
    expect(verdict5h(5, [10, 45])).toMatch(/^FITS comfortably/);
  });

  it("returns FITS at high-usage tier when avg is between bounds and below 80%", () => {
    expect(verdict5h(30, [10, 45])).toMatch(/^FITS at high-usage/);
  });

  it("flags MARGINAL when avg is within 20% of high bound", () => {
    // 40/45 = 89% → marginal
    expect(verdict5h(40, [10, 45])).toMatch(/^MARGINAL \(89% of high bound 45\)/);
  });

  it("returns EXCEEDS when avg strictly above high bound", () => {
    expect(verdict5h(60, [10, 45])).toMatch(/^EXCEEDS by 1\.3x/);
  });

  it("handles open-ended baselines [lo, null] with MARGINAL + EXCEEDS", () => {
    expect(verdict5h(100, [225, null])).toMatch(/^FITS comfortably/);
    expect(verdict5h(200, [225, null])).toMatch(/^MARGINAL \(89% of baseline 225\+\)/);
    expect(verdict5h(300, [225, null])).toMatch(/^EXCEEDS by 1\.3x/);
  });
});

describe("costOn", () => {
  const opus = { label: "Opus", input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 };

  it("multiplies tokens by rate in USD per 1M", () => {
    const t = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheCreationTokens: 0, messageCount: 1 };
    expect(costOn(opus, t)).toBeCloseTo(15 + 75, 6);
  });

  it("falls back cacheRead to input rate when missing", () => {
    const noCache = { label: "X", input: 10, output: 20 };
    const t = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheCreationTokens: 0, messageCount: 1 };
    expect(costOn(noCache, t)).toBeCloseTo(10, 6);
  });

  it("returns 0 for empty totals", () => {
    const t = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, messageCount: 0 };
    expect(costOn(opus, t)).toBe(0);
  });

  it("prices cache-write at its own rate, not input", () => {
    const t = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 1_000_000, messageCount: 0 };
    expect(costOn(opus, t)).toBeCloseTo(18.75, 6);
  });
});

describe("findBestFit", () => {
  const plans = {
    "claude-pro":     { label: "Claude Pro",     monthlyUsd: 20,   messagesPer5h: [10, 45] as [number, number | null] },
    "claude-max-5x":  { label: "Claude Max 5x",  monthlyUsd: 100,  messagesPer5h: [225, null] as [number, number | null], sessionsCap: 50 },
    "claude-ent":     { label: "Claude Enterprise", monthlyUsd: null, messagesPer5h: null },
    "openai-pro":     { label: "OpenAI Pro",     monthlyUsd: 100,  messagesPer5h: [50, 300] as [number, number | null] },
  };

  const stats = (avgPer5h: number, avgSessionsPerMonth = 0) => ({
    totalMessages: 100, daysSpanned: 10, avgPerDay: avgPer5h * 4.8, avgPer5h,
    totalSessions: 0, monthsSpanned: 1, avgSessionsPerMonth,
  });

  it("picks the cheapest comfortable plan as primary", () => {
    const rec = findBestFit(stats(5), plans);
    expect(rec.primary?.key).toBe("claude-pro");
  });

  it("skips MARGINAL plans — they are not eligible as best fit", () => {
    // 40/5h → Pro marginal (89% of 45), Max-5x comfortable, Enterprise comfortable, OpenAI Pro comfortable
    const rec = findBestFit(stats(40), plans);
    expect(rec.primary?.key).toBe("claude-max-5x"); // cheapest non-marginal priced
    expect(rec.cheaperMarginal?.key).toBe("claude-pro");
  });

  it("excludes plans whose sessionsCap is exceeded", () => {
    // avg fits Max-5x's 5h verdict but sessions 100 > cap 50 → blocked
    const rec = findBestFit(stats(100, 100), plans);
    expect(rec.primary?.key).not.toBe("claude-max-5x");
    expect(rec.primary?.key).toBe("openai-pro"); // next cheapest
  });

  it("falls back to marginal-only when no plan is comfortable", () => {
    const only = { "tiny": { label: "Tiny", monthlyUsd: 5, messagesPer5h: [5, 10] as [number, number | null] } };
    const rec = findBestFit(stats(9), only); // 90% of 10
    expect(rec.primary).toBeNull();
    expect(rec.marginal?.key).toBe("tiny");
  });

  it("returns all-null when every plan exceeds", () => {
    const only = { "tiny": { label: "Tiny", monthlyUsd: 5, messagesPer5h: [5, 10] as [number, number | null] } };
    const rec = findBestFit(stats(100), only);
    expect(rec.primary).toBeNull();
    expect(rec.marginal).toBeNull();
  });
});

describe("computeSubscriptionStats", () => {
  it("returns zeros for empty input", () => {
    const s = computeSubscriptionStats(0, null, null);
    expect(s.totalMessages).toBe(0);
    expect(s.avgPer5h).toBe(0);
  });

  it("derives avgPer5h from avgPerDay / 4.8", () => {
    const s = computeSubscriptionStats(480, "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z");
    // 480 msgs / 1 day = 480/day → 480/4.8 = 100/5h
    expect(s.avgPer5h).toBeCloseTo(100, 3);
  });

  it("computes avgSessionsPerMonth from explicit totals", () => {
    const s = computeSubscriptionStats(100, "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z", 60, 2);
    expect(s.avgSessionsPerMonth).toBe(30);
  });
});
