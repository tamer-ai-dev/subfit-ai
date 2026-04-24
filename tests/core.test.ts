import { describe, it, expect } from "vitest";
import {
  normalizeModel,
  verdict5h,
  findBestFit,
  costOn,
  computeSubscriptionStats,
  sanitizeForTerminal,
  sortEvents,
  compute5hWindows,
  simulateDowngrade,
  hitRateBadge,
  groupEventsByMonth,
  simulateMonthlyQuota,
  planFamilyOf,
  detectCurrentFamily,
  type ScanEvent,
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

  it("monthlyBlockedKeys disqualifies plans from 'comfortable' even when 5h verdict fits", () => {
    // All plans have plenty of 5h headroom; copilot is "unlimited" (null).
    // Without the blocked set, cheapest comfortable wins. With copilot
    // flagged as monthly-blocked, it falls out of the pool.
    const mixed = {
      "copilot-pro": { label: "Copilot Pro", monthlyUsd: 10, messagesPer5h: null },
      "claude-pro":  { label: "Claude Pro",  monthlyUsd: 20, messagesPer5h: [10, 45] as [number, number | null] },
    };
    const recOpen = findBestFit(stats(5), mixed);
    expect(recOpen.primary?.key).toBe("copilot-pro"); // cheapest + "unlimited"

    const recBlocked = findBestFit(stats(5), mixed, new Set(["copilot-pro"]));
    expect(recBlocked.primary?.key).toBe("claude-pro");
  });
});

describe("sanitizeForTerminal", () => {
  it("strips ANSI escape sequences from untrusted input", () => {
    // A real-world attack vector: a wire-name containing ESC[2J (clear screen).
    const hostile = "claude\x1b[2J-pwn";
    expect(sanitizeForTerminal(hostile)).toBe("claude[2J-pwn");
  });

  it("strips C1 control characters (0x7F-0x9F)", () => {
    expect(sanitizeForTerminal("abc\x7fdef\x9fghi")).toBe("abcdefghi");
  });

  it("preserves newline (0x0A) but drops other low-range controls", () => {
    expect(sanitizeForTerminal("a\nb\tc\x00d")).toBe("a\nbcd");
  });

  it("is a no-op on clean ASCII and Unicode", () => {
    expect(sanitizeForTerminal("claude-opus-4-7")).toBe("claude-opus-4-7");
    // Non-ASCII Unicode (above 0x9F) must pass through untouched — only
    // C0 and C1 control bands are stripped.
    expect(sanitizeForTerminal("gpt-α-β")).toBe("gpt-α-β");
    expect(sanitizeForTerminal("モデル-7")).toBe("モデル-7");
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

describe("sortEvents", () => {
  const mk = (ts: string): ScanEvent => ({
    ts, inputTokens: 0, outputTokens: 0,
    cacheReadTokens: 0, cacheCreationTokens: 0,
    provider: "claude", model: "claude-opus-4",
  });

  it("handles empty input without throwing", () => {
    const arr: ScanEvent[] = [];
    expect(sortEvents(arr)).toEqual([]);
    expect(arr).toEqual([]);
  });

  it("sorts unordered ISO timestamps ascending and mutates in place", () => {
    const arr = [
      mk("2026-03-12T10:00:00Z"),
      mk("2026-03-10T09:00:00Z"),
      mk("2026-03-11T23:59:59Z"),
    ];
    const returned = sortEvents(arr);
    expect(returned).toBe(arr); // same reference — in-place
    expect(arr.map(e => e.ts)).toEqual([
      "2026-03-10T09:00:00Z",
      "2026-03-11T23:59:59Z",
      "2026-03-12T10:00:00Z",
    ]);
  });

  it("leaves already-sorted input unchanged and preserves ties stably", () => {
    const a = mk("2026-01-01T00:00:00Z"); a.inputTokens = 1;
    const b = mk("2026-01-01T00:00:00Z"); b.inputTokens = 2;
    const c = mk("2026-01-02T00:00:00Z"); c.inputTokens = 3;
    const arr = [a, b, c];
    sortEvents(arr);
    expect(arr).toEqual([a, b, c]);
    expect(arr[0].inputTokens).toBe(1);
    expect(arr[1].inputTokens).toBe(2);
  });
});

describe("compute5hWindows", () => {
  const mk = (ts: string, inTok: number, outTok: number, requestId?: string): ScanEvent => ({
    ts, inputTokens: inTok, outputTokens: outTok,
    cacheReadTokens: 0, cacheCreationTokens: 0,
    provider: "claude", model: "claude-opus-4",
    requestId,
  });

  it("returns [] for empty input", () => {
    expect(compute5hWindows([])).toEqual([]);
  });

  it("folds all events <5h from window-open into a single bucket", () => {
    const events = [
      mk("2026-03-10T09:00:00Z", 1000, 200),
      mk("2026-03-10T11:30:00Z", 500, 100),
      mk("2026-03-10T13:59:00Z", 2000, 400), // 4h59m after open — still inside
    ];
    const w = compute5hWindows(events);
    expect(w).toHaveLength(1);
    expect(w[0].startTs).toBe("2026-03-10T09:00:00Z");
    expect(w[0].endTs).toBe("2026-03-10T14:00:00.000Z"); // toISOString always emits .000Z
    expect(w[0].eventCount).toBe(3);
    expect(w[0].messageCount).toBe(3); // no requestIds → fallback is 1 per event
    expect(w[0].inputTokens).toBe(3500);
    expect(w[0].outputTokens).toBe(700);
    expect(w[0].totalTokens).toBe(4200);
  });

  it("opens a new window reset-on-expiry when an event lands >=5h after open", () => {
    const events = [
      mk("2026-03-10T09:00:00Z", 1000, 0),
      mk("2026-03-10T14:00:00Z", 2000, 0),  // exactly 5h → new window
      mk("2026-03-10T15:00:00Z", 500, 0),   // inside the second window
      mk("2026-03-10T23:00:00Z", 100, 0),   // >5h after second open (9h) → third
    ];
    const w = compute5hWindows(events);
    expect(w).toHaveLength(3);
    expect(w[0].startTs).toBe("2026-03-10T09:00:00Z");
    expect(w[0].eventCount).toBe(1);
    expect(w[1].startTs).toBe("2026-03-10T14:00:00Z");
    expect(w[1].eventCount).toBe(2);
    expect(w[1].totalTokens).toBe(2500);
    expect(w[2].startTs).toBe("2026-03-10T23:00:00Z");
    expect(w[2].eventCount).toBe(1);
  });

  it("sorts unordered input before bucketing", () => {
    const events = [
      mk("2026-03-10T13:00:00Z", 100, 0),
      mk("2026-03-10T09:00:00Z", 500, 0),
      mk("2026-03-10T11:00:00Z", 200, 0),
    ];
    const w = compute5hWindows(events);
    expect(w).toHaveLength(1);
    expect(w[0].startTs).toBe("2026-03-10T09:00:00Z");
    expect(w[0].inputTokens).toBe(800);
    // Input array is not mutated — callers pass raw ctx.events freely.
    expect(events[0].ts).toBe("2026-03-10T13:00:00Z");
  });

  it("dedups events sharing a requestId into one message", () => {
    // One API call streamed as 3 content-block lines (all share req-1),
    // then a second API call (req-2) with 1 line. 4 events, 2 messages.
    const events = [
      mk("2026-03-10T09:00:00Z", 100, 0, "req-1"),
      mk("2026-03-10T09:00:01Z", 0,   0, "req-1"),
      mk("2026-03-10T09:00:02Z", 0,   50, "req-1"),
      mk("2026-03-10T09:05:00Z", 200, 0, "req-2"),
    ];
    const w = compute5hWindows(events);
    expect(w).toHaveLength(1);
    expect(w[0].eventCount).toBe(4);
    expect(w[0].messageCount).toBe(2); // deduped
  });

  it("counts events without a requestId as 1 message each (non-Claude providers)", () => {
    const events = [
      mk("2026-03-10T09:00:00Z", 10, 0),  // undefined requestId
      mk("2026-03-10T09:30:00Z", 20, 0),
      mk("2026-03-10T10:00:00Z", 30, 0),
    ];
    const w = compute5hWindows(events);
    expect(w).toHaveLength(1);
    expect(w[0].eventCount).toBe(3);
    expect(w[0].messageCount).toBe(3);
  });

  it("handles a mixed window: some events share a requestId, others have none", () => {
    const events = [
      // API call 1: 3 streamed lines share req-1
      mk("2026-03-10T09:00:00Z", 100, 0, "req-1"),
      mk("2026-03-10T09:00:01Z", 0,   50, "req-1"),
      mk("2026-03-10T09:00:02Z", 0,   10, "req-1"),
      // API call 2: single line, req-2
      mk("2026-03-10T09:10:00Z", 50, 0, "req-2"),
      // Non-Claude provider event without requestId
      mk("2026-03-10T09:15:00Z", 10, 10),
      // Another non-Claude event, also no requestId
      mk("2026-03-10T09:20:00Z", 5,  5),
    ];
    const w = compute5hWindows(events);
    expect(w).toHaveLength(1);
    expect(w[0].eventCount).toBe(6);
    // 1 (req-1) + 1 (req-2) + 1 + 1 (missing requestIds each count as 1) = 4
    expect(w[0].messageCount).toBe(4);
  });

  it("requestId dedup is per-window: same requestId in two windows counts twice", () => {
    // Two windows >5h apart. If for some reason the same requestId
    // appeared in both (shouldn't happen in practice, but let's be
    // explicit), each window should count it once.
    const events = [
      mk("2026-03-10T09:00:00Z", 100, 0, "req-1"),
      mk("2026-03-10T09:00:01Z", 0,   50, "req-1"),
      mk("2026-03-10T20:00:00Z", 100, 0, "req-1"), // 11h later → new window
    ];
    const w = compute5hWindows(events);
    expect(w).toHaveLength(2);
    expect(w[0].messageCount).toBe(1);
    expect(w[1].messageCount).toBe(1);
  });
});

describe("simulateDowngrade + hitRateBadge", () => {
  const mk = (ts: string): ScanEvent => ({
    ts, inputTokens: 1, outputTokens: 1,
    cacheReadTokens: 0, cacheCreationTokens: 0,
    provider: "claude", model: "claude-opus-4",
  });

  it("hitRateBadge six-level thresholds (≤1/5/15/35/60/>60)", () => {
    expect(hitRateBadge(0).kind).toBe("smooth");
    expect(hitRateBadge(1).kind).toBe("smooth");
    expect(hitRateBadge(1.01).kind).toBe("comfortable");
    expect(hitRateBadge(5).kind).toBe("comfortable");
    expect(hitRateBadge(5.01).kind).toBe("workable");
    expect(hitRateBadge(15).kind).toBe("workable");
    expect(hitRateBadge(15.01).kind).toBe("painful");
    expect(hitRateBadge(35).kind).toBe("painful");
    expect(hitRateBadge(35.01).kind).toBe("frustrating");
    expect(hitRateBadge(60).kind).toBe("frustrating");
    expect(hitRateBadge(60.01).kind).toBe("unusable");
    expect(hitRateBadge(100).kind).toBe("unusable");
  });

  it("counts windows whose message count exceeds the plan cap (cache-reads ignored)", () => {
    // Build three windows with 5, 50, and 500 messages. Put each in its
    // own day so the 5h reset-on-expiry rule yields one window per set.
    const makeBurst = (base: string, count: number) => {
      const out: ScanEvent[] = [];
      for (let i = 0; i < count; i++) {
        // Space events 10s apart — all comfortably inside a single 5h window.
        const sec = String(i * 10).padStart(4, "0");
        out.push(mk(`${base}T09:00:${sec.slice(0,2)}.${sec.slice(2,4)}0Z`));
      }
      return out;
    };
    const events = [
      ...makeBurst("2026-03-10", 5),
      ...makeBurst("2026-03-11", 50),
      ...makeBurst("2026-03-12", 500),
    ];
    const windows = compute5hWindows(events);
    expect(windows).toHaveLength(3);
    expect(windows.map(w => w.eventCount)).toEqual([5, 50, 500]);

    const planLimits = {
      "claude-pro":        { label: "Claude Pro",        monthlyUsd: 20,   messagesPer5h: [10, 45]    as [number, number] },
      "claude-max-5":      { label: "Claude Max 5",      monthlyUsd: 100,  messagesPer5h: [225, null] as [number, null]   },
      "claude-max-20":     { label: "Claude Max 20",     monthlyUsd: 200,  messagesPer5h: [900, null] as [number, null]   },
      "claude-enterprise": { label: "Claude Enterprise", monthlyUsd: null, messagesPer5h: null                               }, // unlimited → included, 0 hits
      // Copilot-style: null messagesPer5h + monthlyMsgCap set → monthlyMetered=true
      "copilot-pro":       { label: "Copilot Pro",       monthlyUsd: 10,   messagesPer5h: null, monthlyMsgCap: 300 },
    };
    const sim = simulateDowngrade(windows, planLimits);

    // All plans now appear (even null-cap ones), sorted by price.
    expect(sim.rows.map(r => r.key).sort()).toEqual(
      ["claude-enterprise", "claude-max-20", "claude-max-5", "claude-pro", "copilot-pro"],
    );

    const pro = sim.rows.find(r => r.key === "claude-pro")!;
    expect(pro.msgsPer5h).toBe(45);                 // hi bound of [10, 45]
    expect(pro.hitCount).toBe(2);                   // 50 and 500 exceed 45
    expect(pro.hitPct).toBeCloseTo(66.67, 1);
    expect(pro.verdict.kind).toBe("unusable");      // >60%
    expect(pro.family).toBe("claude");

    const max5 = sim.rows.find(r => r.key === "claude-max-5")!;
    expect(max5.msgsPer5h).toBe(225);               // "lo+" baseline uses lo
    expect(max5.hitCount).toBe(1);                  // only 500 exceeds 225
    expect(max5.verdict.kind).toBe("painful");      // 33% falls in 15-35

    const max20 = sim.rows.find(r => r.key === "claude-max-20")!;
    expect(max20.msgsPer5h).toBe(900);
    expect(max20.hitCount).toBe(0);
    expect(max20.verdict.kind).toBe("smooth");

    const ent = sim.rows.find(r => r.key === "claude-enterprise")!;
    expect(ent.msgsPer5h).toBeNull();               // truly unlimited
    expect(ent.hitCount).toBe(0);
    expect(ent.verdict.kind).toBe("smooth");
    expect(ent.monthlyMetered).toBe(false);

    const copilot = sim.rows.find(r => r.key === "copilot-pro")!;
    expect(copilot.msgsPer5h).toBeNull();
    expect(copilot.monthlyMetered).toBe(true);      // 5h=null + monthlyMsgCap set
    expect(copilot.family).toBe("copilot");

    // Summary metrics: avg = (5+50+500)/3 ≈ 185, peak = 500.
    expect(sim.peakMsgsPerWindow).toBe(500);
    expect(Math.round(sim.avgMsgsPerWindow)).toBe(185);
  });

  it("returns zero counts for empty windows with no divide-by-zero", () => {
    const planLimits = {
      "claude-pro": { label: "Claude Pro", monthlyUsd: 20, messagesPer5h: [10, 45] as [number, number] },
    };
    const sim = simulateDowngrade([], planLimits);
    expect(sim.totalWindows).toBe(0);
    expect(sim.avgMsgsPerWindow).toBe(0);
    expect(sim.peakMsgsPerWindow).toBe(0);
    expect(sim.rows).toHaveLength(1);
    expect(sim.rows[0].hitCount).toBe(0);
    expect(sim.rows[0].hitPct).toBe(0);
    expect(sim.rows[0].verdict.kind).toBe("smooth");
  });
});

describe("groupEventsByMonth + simulateMonthlyQuota", () => {
  const mk = (ts: string, requestId?: string): ScanEvent => ({
    ts, inputTokens: 1, outputTokens: 0,
    cacheReadTokens: 0, cacheCreationTokens: 0,
    provider: "claude", model: "claude-opus-4",
    requestId,
  });

  it("returns [] / empty-rows simulation for empty events", () => {
    expect(groupEventsByMonth([])).toEqual([]);
    const sim = simulateMonthlyQuota([], {
      "copilot-pro": {
        label: "GitHub Copilot Pro", monthlyUsd: 10,
        messagesPer5h: null, monthlyMsgCap: 500,
      },
    });
    expect(sim.totalMonths).toBe(0);
    expect(sim.firstMonth).toBeNull();
    expect(sim.avgMsgsPerMonth).toBe(0);
    expect(sim.peakMsgsPerMonth).toBe(0);
    expect(sim.rows).toHaveLength(1);
    expect(sim.rows[0].hitCount).toBe(0);
    expect(sim.rows[0].verdict.kind).toBe("smooth");
  });

  it("groups events into calendar months, dedups requestId within each month", () => {
    const events = [
      // Jan: 2 API calls (3 streamed lines share req-1, then a req-2)
      mk("2026-01-05T09:00:00Z", "req-1"),
      mk("2026-01-05T09:00:01Z", "req-1"),
      mk("2026-01-05T09:00:02Z", "req-1"),
      mk("2026-01-06T10:00:00Z", "req-2"),
      // Feb: 1 API call (single event, no requestId → counts as 1)
      mk("2026-02-14T12:00:00Z"),
      // Mar: 5 events with 5 distinct requestIds
      mk("2026-03-01T08:00:00Z", "r1"),
      mk("2026-03-02T08:00:00Z", "r2"),
      mk("2026-03-03T08:00:00Z", "r3"),
      mk("2026-03-04T08:00:00Z", "r4"),
      mk("2026-03-05T08:00:00Z", "r5"),
    ];
    const months = groupEventsByMonth(events);
    expect(months.map(m => m.yearMonth)).toEqual(["2026-01", "2026-02", "2026-03"]);
    expect(months[0]).toMatchObject({ yearMonth: "2026-01", eventCount: 4, messageCount: 2 });
    expect(months[1]).toMatchObject({ yearMonth: "2026-02", eventCount: 1, messageCount: 1 });
    expect(months[2]).toMatchObject({ yearMonth: "2026-03", eventCount: 5, messageCount: 5 });
  });

  it("counts months over plan cap and respects hitRateBadge thresholds", () => {
    // Four months with message counts 100, 600, 1500, 3500.
    const mkMonth = (base: string, count: number): ScanEvent[] => {
      const out: ScanEvent[] = [];
      for (let i = 0; i < count; i++) {
        out.push(mk(`${base}T00:00:00Z`, `${base}-${i}`));
      }
      return out;
    };
    const events = [
      ...mkMonth("2026-01-05", 100),
      ...mkMonth("2026-02-05", 600),
      ...mkMonth("2026-03-05", 1500),
      ...mkMonth("2026-04-05", 3500),
    ];
    const months = groupEventsByMonth(events);
    expect(months).toHaveLength(4);
    expect(months.map(m => m.messageCount)).toEqual([100, 600, 1500, 3500]);

    const planLimits = {
      "copilot-free":     { label: "Copilot Free",     monthlyUsd: 0,  messagesPer5h: null, monthlyMsgCap: 2000 },
      "copilot-pro":      { label: "Copilot Pro",      monthlyUsd: 10, messagesPer5h: null, monthlyMsgCap: 500  },
      "copilot-business": { label: "Copilot Business", monthlyUsd: 19, messagesPer5h: null, monthlyMsgCap: 1000 },
      // A plan with NO monthly cap is skipped from the rows entirely.
      "claude-pro":       { label: "Claude Pro",       monthlyUsd: 20, messagesPer5h: [10, 45] as [number, number] },
    };
    const sim = simulateMonthlyQuota(months, planLimits);
    expect(sim.rows.map(r => r.key)).toEqual(["copilot-free", "copilot-pro", "copilot-business"]);
    expect(sim.firstMonth).toBe("2026-01");
    expect(sim.lastMonth).toBe("2026-04");
    expect(sim.peakMsgsPerMonth).toBe(3500);

    const free = sim.rows.find(r => r.key === "copilot-free")!;
    expect(free.hitCount).toBe(1);          // only 3500 exceeds 2000
    expect(free.hitPct).toBeCloseTo(25);
    expect(free.verdict.kind).toBe("painful"); // 25% falls in 15-35 (painful)

    const pro = sim.rows.find(r => r.key === "copilot-pro")!;
    expect(pro.hitCount).toBe(3);           // 600, 1500, 3500 exceed 500
    expect(pro.hitPct).toBe(75);
    expect(pro.verdict.kind).toBe("unusable"); // >60%

    const biz = sim.rows.find(r => r.key === "copilot-business")!;
    expect(biz.hitCount).toBe(2);           // 1500 and 3500 exceed 1000
    expect(biz.verdict.kind).toBe("frustrating"); // 50% falls in 35-60 (frustrating)
  });

  it("treats a partial month as one entry (hit % uses raw month count)", () => {
    // Single month with just 3 days of activity — still counts as one
    // full 'month' in the simulation. Downstream users are responsible
    // for interpreting that number; we do not annotate completeness.
    const events = [
      mk("2026-04-22T09:00:00Z", "r1"),
      mk("2026-04-23T09:00:00Z", "r2"),
      mk("2026-04-24T09:00:00Z", "r3"),
    ];
    const months = groupEventsByMonth(events);
    expect(months).toHaveLength(1);
    expect(months[0].messageCount).toBe(3);

    const sim = simulateMonthlyQuota(months, {
      "tiny": { label: "Tiny", monthlyUsd: 1, messagesPer5h: null, monthlyMsgCap: 2 },
    });
    expect(sim.totalMonths).toBe(1);
    expect(sim.rows[0].hitCount).toBe(1);
    expect(sim.rows[0].hitPct).toBe(100);
    expect(sim.rows[0].verdict.kind).toBe("unusable");
    expect(sim.rows[0].monthlyCapUnit).toBe("msgs"); // default unit
  });

  it("passes through a custom monthlyCapUnit (e.g. Copilot 'premium req')", () => {
    const events = [mk("2026-04-01T09:00:00Z", "r1")];
    const months = groupEventsByMonth(events);
    const sim = simulateMonthlyQuota(months, {
      "copilot-pro": {
        label: "Copilot Pro", monthlyUsd: 10,
        messagesPer5h: null, monthlyMsgCap: 300,
        monthlyCapUnit: "premium req",
      },
    });
    expect(sim.rows[0].monthlyCapUnit).toBe("premium req");
  });
});

describe("planFamilyOf + detectCurrentFamily", () => {
  it("maps plan keys to families by prefix", () => {
    expect(planFamilyOf("claude-pro")).toBe("claude");
    expect(planFamilyOf("claude-max-20x")).toBe("claude");
    expect(planFamilyOf("openai-pro-20")).toBe("openai");
    expect(planFamilyOf("mistral-pro")).toBe("mistral");
    expect(planFamilyOf("copilot-enterprise")).toBe("copilot");
    expect(planFamilyOf("unknown-thing")).toBe("other");
  });

  it("picks the top-message family from byModel tallies", () => {
    const byModel = new Map([
      ["claude-opus-4",  { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, messageCount: 500 }],
      ["codex-standard", { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, messageCount: 100 }],
      ["gemini-pro",     { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, messageCount:  50 }],
    ]);
    expect(detectCurrentFamily(byModel)).toBe("claude");
  });

  it("routes devstral to mistral, codex to openai, gemini to other", () => {
    const devHeavy = new Map([
      ["devstral-2", { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, messageCount: 200 }],
    ]);
    expect(detectCurrentFamily(devHeavy)).toBe("mistral");

    const codexHeavy = new Map([
      ["codex-standard", { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, messageCount: 200 }],
    ]);
    expect(detectCurrentFamily(codexHeavy)).toBe("openai");

    const geminiOnly = new Map([
      ["gemini-pro", { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, messageCount: 200 }],
    ]);
    // Gemini has no subscription family in config → "other" signals the
    // renderer to skip the same-provider downgrade section.
    expect(detectCurrentFamily(geminiOnly)).toBe("other");
  });

  it("returns 'other' when byModel is empty", () => {
    expect(detectCurrentFamily(new Map())).toBe("other");
  });
});
