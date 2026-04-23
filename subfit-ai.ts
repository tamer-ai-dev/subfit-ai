#!/usr/bin/env -S npx tsx
/**
 * subfit-ai — find the plan that fits your usage. Reads Claude Code session
 * JSONL files, computes what the same token volume would have cost on OpenAI
 * Codex, and checks which subscription tier (Claude Max, OpenAI Plus/Pro/
 * Pro 20x) actually fits your average 5-hour usage.
 *
 * Default scan root is ~/.claude (NOT ~/.claude/projects) — some sessions
 * live outside projects/. Walks recursively, only parses lines whose
 * type==="assistant" with a usage block; noise is skipped silently.
 *
 * Usage:
 *   npx tsx ./subfit-ai.ts              # scan default ~/.claude
 *   npx tsx ./subfit-ai.ts --path <dir> # scan a custom dir
 *   npx tsx ./subfit-ai.ts --json       # machine output
 *   npx tsx ./subfit-ai.ts --no-monthly # skip monthly breakdown
 *   npx tsx ./subfit-ai.ts --help
 */

import { readdirSync, readFileSync, statSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

// ───────────────────────────────────────────────────────────────────────────
// Config types + loader. Rates and plan caps live in config.json (same
// directory as this script by default, or --config <path>). If the file is
// missing or malformed, the embedded FALLBACK_CONFIG is used — the script
// keeps working with whatever was current at commit time.
// ───────────────────────────────────────────────────────────────────────────

interface ModelPricing {
  label: string;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

interface PlanLimits {
  label: string;
  /** USD per month; null = custom / contact sales (e.g. Enterprise tiers). */
  monthlyUsd: number | null;
  /**
   * Messages per 5-hour window.
   *   null             → truly unlimited (rate-limited only; e.g. Enterprise).
   *   [lo, hi]         → fixed band; verdict compares against both bounds.
   *   [lo, null]       → "lo+" baseline with no published ceiling; verdict
   *                      compares against `lo` only (Claude Max tiers).
   */
  messagesPer5h: [number, number | null] | null;
  /** Max sessions (~distinct JSONL files) per month; null = no session cap. */
  sessionsCap?: number | null;
  /** Short note shown alongside verdict. */
  note?: string;
}

interface CostCompareConfig {
  pricing: Record<string, ModelPricing>;
  planLimits: Record<string, PlanLimits>;
}

/** Resolve the directory where this script lives (for default config lookup). */
function scriptDir(): string {
  try { return dirname(fileURLToPath(import.meta.url)); }
  catch { return process.cwd(); }
}

/** Fallback used when no config file is reachable. Loaded from default-config.json
 *  adjacent to this script. If that file is itself missing or malformed, we
 *  degrade to an empty config — the run still completes, tables just render "—".
 *  Kept as a read at import time so tests / callers can inspect it statically. */
function loadEmbeddedDefaults(): CostCompareConfig {
  try {
    const p = join(scriptDir(), "default-config.json");
    const raw = readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw) as Partial<CostCompareConfig>;
    if (parsed?.pricing && parsed?.planLimits) {
      return { pricing: parsed.pricing, planLimits: parsed.planLimits };
    }
  } catch { /* swallow — fall through to empty */ }
  return { pricing: {}, planLimits: {} };
}

const FALLBACK_CONFIG: CostCompareConfig = loadEmbeddedDefaults();

/**
 * Load config from a JSON file. If `explicitPath` is provided, it MUST exist
 * (hard error — caller passed it). If not, probe <scriptDir>/config.json
 * and fall back to FALLBACK_CONFIG on any failure.
 */
export function loadConfig(explicitPath?: string): { config: CostCompareConfig; source: string } {
  const probe = explicitPath ?? join(scriptDir(), "config.json");
  if (!existsSync(probe)) {
    if (explicitPath) {
      process.stderr.write(`subfit-ai: --config path not found: ${explicitPath}\n`);
      process.stderr.write(`  falling back to embedded defaults\n`);
    }
    return { config: FALLBACK_CONFIG, source: "fallback" };
  }
  try {
    const raw = readFileSync(probe, "utf-8");
    const parsed = JSON.parse(raw) as Partial<CostCompareConfig>;
    if (!parsed || typeof parsed !== "object" || !parsed.pricing || !parsed.planLimits) {
      process.stderr.write(`subfit-ai: config at ${probe} is missing pricing/planLimits — using fallback\n`);
      return { config: FALLBACK_CONFIG, source: "fallback" };
    }
    return { config: { pricing: parsed.pricing, planLimits: parsed.planLimits }, source: probe };
  } catch (err: any) {
    process.stderr.write(`subfit-ai: failed to parse ${probe}: ${err?.message ?? err}\n`);
    process.stderr.write(`  falling back to embedded defaults\n`);
    return { config: FALLBACK_CONFIG, source: "fallback" };
  }
}

// ───────────────────────────────────────────────────────────────────────────
// CLI args
// ───────────────────────────────────────────────────────────────────────────

interface Args {
  path: string;
  json: boolean;
  help: boolean;
  monthly: boolean;
  config: string | null;
  /** null = no export, "" placeholder = user wrote --export without value, else path */
  exportPath: string | null;
  /** Unrecognized tokens — main() emits stderr warnings so tests can inspect parsing in isolation. */
  unknownFlags: string[];
}

const DEFAULT_EXPORT_PATH = "subfit-report.md";

function parseArgs(argv: string[]): Args {
  const args: Args = {
    path: join(homedir(), ".claude"),
    json: false,
    help: false,
    monthly: true,
    config: null,
    exportPath: null,
    unknownFlags: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--json") args.json = true;
    else if (a === "--no-monthly") args.monthly = false;
    else if (a === "--path") args.path = argv[++i] ?? args.path;
    else if (a.startsWith("--path=")) args.path = a.slice("--path=".length);
    else if (a === "--config") args.config = argv[++i] ?? null;
    else if (a.startsWith("--config=")) args.config = a.slice("--config=".length);
    else if (a === "--export") {
      // --export may take an explicit path or default to DEFAULT_EXPORT_PATH
      // when the next token looks like another flag / is absent.
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) { args.exportPath = next; i++; }
      else args.exportPath = DEFAULT_EXPORT_PATH;
    }
    else if (a.startsWith("--export=")) args.exportPath = a.slice("--export=".length) || DEFAULT_EXPORT_PATH;
    else if (a.startsWith("-")) args.unknownFlags.push(a);
    else args.unknownFlags.push(a);
  }
  return args;
}

function printHelp(): void {
  process.stdout.write(`subfit-ai — find the plan that fits your usage. Compares Claude vs OpenAI
Codex pricing on your session history and checks which subscription tier fits.

USAGE
  npx tsx ./subfit-ai.ts [options]
  subfit-ai [options]                            # if installed as bin

OPTIONS
  --path <dir>    Root directory holding Claude JSONL sessions (default: ~/.claude).
                  Scanned RECURSIVELY — every *.jsonl at any depth is considered.
  --config <file> Path to a pricing/plan-limits JSON (default:
                  <script-dir>/config.json; falls back to built-in defaults
                  if the file is missing or malformed).
  --json          Emit machine-readable JSON instead of a terminal table.
  --no-monthly    Skip the monthly breakdown (per-model table only).
  --export [file] Write a Markdown (GFM) report. If no file is given, defaults
                  to ./subfit-report.md. Overwrites existing files with a warning.
                  Can be combined with normal terminal output.
  -h, --help      Show this help.

WHAT IT DOES
  Walks the given directory recursively, parses every *.jsonl file line by line,
  picks lines with type === "assistant", reads message.model + message.usage +
  timestamp, and sums per model AND per YYYY-MM:
    input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens

  Then computes:
    - real cost on the Claude model that produced each token
    - equivalent cost on OpenAI Codex (standard and priority tiers)
    - savings ratio (Codex standard / Claude real)
    - date range of the data (first message → last message)

CONFIG FILE
  config.json (co-located with the script) holds:
    { "pricing": { ... }, "planLimits": { ... } }
  Edit the JSON to change rates or plan caps without touching TypeScript.
  The script embeds a fallback snapshot so it still runs if the file is missing.
`);
}

// ───────────────────────────────────────────────────────────────────────────
// Recursive scanning
// ───────────────────────────────────────────────────────────────────────────

interface ModelTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  messageCount: number;
}

function emptyTotals(): ModelTotals {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, messageCount: 0 };
}

/** Walk root recursively, return every *.jsonl file path. Guards against cycles and unreadable dirs. */
export function findJsonlFiles(root: string): string[] {
  const files: string[] = [];
  if (!existsSync(root)) return files;

  const seen = new Set<string>();
  const stack: string[] = [root];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    if (seen.has(dir)) continue;
    seen.add(dir);

    let st;
    try { st = statSync(dir); } catch { continue; }

    if (st.isFile()) {
      if (dir.endsWith(".jsonl")) files.push(dir);
      continue;
    }
    if (!st.isDirectory()) continue;

    let entries: string[];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      // Skip dot-dirs we know are noise (cache, statsig) but keep everything else.
      // This is a heuristic — only matters at the very top level.
      if (dir === root && (name === "paste-cache" || name === "statsig" || name === "cache" || name === "telemetry")) continue;
      const p = join(dir, name);
      let sub;
      try { sub = statSync(p); } catch { continue; }
      if (sub.isDirectory()) stack.push(p);
      else if (sub.isFile() && name.endsWith(".jsonl")) files.push(p);
    }
  }
  return files;
}

/** message.model wire id → PRICING key. Loose matching: any wire name containing
 *  "haiku" / "sonnet" / "opus" (case-insensitive) buckets into the corresponding
 *  family key. Concrete wire names verified to map correctly:
 *
 *    claude-opus-4, claude-opus-4-5, claude-opus-4-7             → claude-opus-4
 *    claude-sonnet-4, claude-sonnet-4-5, claude-sonnet-4-6       → claude-sonnet-4
 *    claude-haiku-4-5, claude-haiku-4-5-20251001                 → claude-haiku-4-5
 *
 *  So point-release versions (4-6, 4-7, dated snapshots) are priced at the family
 *  rate — no $0 gap when Anthropic ships a new Opus/Sonnet/Haiku revision. Update
 *  this table if a pricing divergence is introduced between minor versions.
 *
 *  Unknown strings fall back to opus with `matched: false` so the caller warns
 *  once per run instead of silently mispricing. */
export function normalizeModel(m: string | undefined): { key: string; matched: boolean } {
  if (!m) return { key: "claude-opus-4", matched: false };
  const low = m.toLowerCase();
  if (low.includes("haiku")) return { key: "claude-haiku-4-5", matched: true };
  if (low.includes("sonnet")) return { key: "claude-sonnet-4", matched: true };
  if (low.includes("opus")) return { key: "claude-opus-4", matched: true };
  return { key: "claude-opus-4", matched: false };
}

/** Extract a YYYY-MM bucket from an ISO timestamp. Returns null on parse failure. */
export function yearMonth(ts: string | undefined): string | null {
  if (!ts || typeof ts !== "string") return null;
  // Cheap check — expect "YYYY-MM-DDT..." format
  if (ts.length < 7 || ts[4] !== "-" || ts[7] !== "-") {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return null;
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  }
  return ts.slice(0, 7);
}

interface ScanContext {
  byModel: Map<string, ModelTotals>;
  byMonth: Map<string, Map<string, ModelTotals>>;
  minTs: string | null;
  maxTs: string | null;
  totalLines: number;
  assistantLines: number;
  withUsage: number;
  parseErrors: number;
  /** Raw model strings that didn't match haiku/sonnet/opus — bucketed as opus as a fallback. */
  unknownModels: Set<string>;
}

function scanJsonl(filePath: string, ctx: ScanContext): void {
  let content: string;
  try { content = readFileSync(filePath, "utf-8"); }
  catch { return; }

  for (const raw of content.split("\n")) {
    if (!raw) continue;
    ctx.totalLines++;
    let obj: any;
    try { obj = JSON.parse(raw); } catch { ctx.parseErrors++; continue; }
    if (obj?.type !== "assistant") continue;
    ctx.assistantLines++;
    const u = obj.message?.usage;
    if (!u) continue;
    ctx.withUsage++;

    const rawModel = obj.message?.model;
    const { key: model, matched } = normalizeModel(rawModel);
    if (!matched && typeof rawModel === "string" && rawModel) ctx.unknownModels.add(rawModel);
    const ts: string | undefined = obj.timestamp;
    if (ts && (!ctx.minTs || ts < ctx.minTs)) ctx.minTs = ts;
    if (ts && (!ctx.maxTs || ts > ctx.maxTs)) ctx.maxTs = ts;

    const addInto = (t: ModelTotals) => {
      t.inputTokens += u.input_tokens ?? 0;
      t.outputTokens += u.output_tokens ?? 0;
      t.cacheReadTokens += u.cache_read_input_tokens ?? 0;
      t.cacheCreationTokens += u.cache_creation_input_tokens ?? 0;
      t.messageCount++;
    };

    let mt = ctx.byModel.get(model);
    if (!mt) { mt = emptyTotals(); ctx.byModel.set(model, mt); }
    addInto(mt);

    const ym = yearMonth(ts);
    if (ym) {
      let monthBucket = ctx.byMonth.get(ym);
      if (!monthBucket) { monthBucket = new Map(); ctx.byMonth.set(ym, monthBucket); }
      let mmt = monthBucket.get(model);
      if (!mmt) { mmt = emptyTotals(); monthBucket.set(model, mmt); }
      addInto(mmt);
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Cost math
// ───────────────────────────────────────────────────────────────────────────

export function costOn(model: ModelPricing, t: ModelTotals): number {
  const perM = 1_000_000;
  const cacheReadRate = model.cacheRead ?? model.input;
  const cacheWriteRate = model.cacheWrite ?? model.input;
  return (
    (t.inputTokens / perM) * model.input +
    (t.outputTokens / perM) * model.output +
    (t.cacheReadTokens / perM) * cacheReadRate +
    (t.cacheCreationTokens / perM) * cacheWriteRate
  );
}

function fmtUsd(n: number): string {
  if (n >= 10) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(6)}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// ───────────────────────────────────────────────────────────────────────────
// Rendering
// ───────────────────────────────────────────────────────────────────────────

interface ModelRow {
  model: string;
  label: string;
  totals: ModelTotals;
  costClaude: number;
  /** null when codex-standard pricing is not configured. */
  costCodexStandard: number | null;
  /** null when codex-priority pricing is not configured. */
  costCodexPriority: number | null;
}

function computeRows(bucket: Map<string, ModelTotals>, pricing: Record<string, ModelPricing>): ModelRow[] {
  const rows: ModelRow[] = [];
  const codexStd = pricing["codex-standard"] ?? null;
  const codexPri = pricing["codex-priority"] ?? null;
  for (const [model, t] of bucket) {
    const claudePrice = pricing[model];
    if (!claudePrice) continue;
    rows.push({
      model, label: claudePrice.label, totals: t,
      costClaude: costOn(claudePrice, t),
      costCodexStandard: codexStd ? costOn(codexStd, t) : null,
      costCodexPriority: codexPri ? costOn(codexPri, t) : null,
    });
  }
  rows.sort((a, b) => b.costClaude - a.costClaude);
  return rows;
}

function fmtUsdOrDash(n: number | null): string {
  return n === null ? "—" : fmtUsd(n);
}
function savingsOrDash(claude: number, codex: number | null): string {
  if (codex === null) return "—";
  return claude > 0 ? `${(codex / claude).toFixed(2)}x` : "—";
}

function renderTable(header: string[], body: string[][]): string[] {
  const widths = header.map((_, i) => Math.max(header[i].length, ...body.map(r => (r[i] ?? "").length)));
  const fmtRow = (cells: string[]) => cells.map((c, i) => (c ?? "").padEnd(widths[i])).join("  ");
  const sep = widths.map(w => "─".repeat(w)).join("  ");
  const out: string[] = [fmtRow(header), sep];
  for (const r of body) out.push(fmtRow(r));
  return out;
}

function renderModelSection(rows: ModelRow[]): string {
  if (rows.length === 0) return "No assistant messages with usage found.\n";

  const header = ["Model", "Msgs", "In", "Out", "CacheR", "CacheW", "Claude $", "Codex-Std $", "Codex-Pri $", "Savings"];
  const body: string[][] = rows.map(r => [
    r.label, String(r.totals.messageCount),
    fmtTokens(r.totals.inputTokens), fmtTokens(r.totals.outputTokens),
    fmtTokens(r.totals.cacheReadTokens), fmtTokens(r.totals.cacheCreationTokens),
    fmtUsd(r.costClaude), fmtUsdOrDash(r.costCodexStandard), fmtUsdOrDash(r.costCodexPriority),
    savingsOrDash(r.costClaude, r.costCodexStandard),
  ]);

  const tot = rows.reduce((acc, r) => {
    acc.msgs += r.totals.messageCount;
    acc.in += r.totals.inputTokens;
    acc.out += r.totals.outputTokens;
    acc.cr += r.totals.cacheReadTokens;
    acc.cw += r.totals.cacheCreationTokens;
    acc.costClaude += r.costClaude;
    if (r.costCodexStandard !== null) { acc.codexStd += r.costCodexStandard; acc.codexStdSeen = true; }
    if (r.costCodexPriority !== null) { acc.codexPri += r.costCodexPriority; acc.codexPriSeen = true; }
    return acc;
  }, { msgs: 0, in: 0, out: 0, cr: 0, cw: 0, costClaude: 0, codexStd: 0, codexPri: 0, codexStdSeen: false, codexPriSeen: false });
  body.push([
    "TOTAL", String(tot.msgs),
    fmtTokens(tot.in), fmtTokens(tot.out),
    fmtTokens(tot.cr), fmtTokens(tot.cw),
    fmtUsd(tot.costClaude),
    tot.codexStdSeen ? fmtUsd(tot.codexStd) : "—",
    tot.codexPriSeen ? fmtUsd(tot.codexPri) : "—",
    tot.codexStdSeen && tot.costClaude > 0 ? `${(tot.codexStd / tot.costClaude).toFixed(2)}x` : "—",
  ]);
  return renderTable(header, body).join("\n") + "\n";
}

// ───────────────────────────────────────────────────────────────────────────
// Subscription comparison
// ───────────────────────────────────────────────────────────────────────────

interface SubscriptionStats {
  totalMessages: number;
  daysSpanned: number;
  avgPerDay: number;
  avgPer5h: number;
  /** Distinct JSONL files treated as sessions (each .jsonl ≈ 1 Claude session). */
  totalSessions: number;
  /** Number of distinct YYYY-MM buckets with at least one message. */
  monthsSpanned: number;
  avgSessionsPerMonth: number;
}

export function computeSubscriptionStats(
  totalMessages: number,
  minTs: string | null,
  maxTs: string | null,
  totalSessions: number = 0,
  monthsSpanned: number = 0,
): SubscriptionStats {
  if (!minTs || !maxTs || totalMessages === 0) {
    return { totalMessages, daysSpanned: 0, avgPerDay: 0, avgPer5h: 0, totalSessions, monthsSpanned, avgSessionsPerMonth: 0 };
  }
  const span = new Date(maxTs).getTime() - new Date(minTs).getTime();
  const daysSpanned = Math.max(1, span / (24 * 3600 * 1000));
  const avgPerDay = totalMessages / daysSpanned;
  // 24h / 5h = 4.8 windows per day (approximate active-usage floor)
  const avgPer5h = avgPerDay / 4.8;
  const avgSessionsPerMonth = monthsSpanned > 0 ? totalSessions / monthsSpanned : 0;
  return { totalMessages, daysSpanned, avgPerDay, avgPer5h, totalSessions, monthsSpanned, avgSessionsPerMonth };
}

const MAX_SESSIONS_PER_MONTH_CAP = 50;

const VOLATILITY_WARNING =
  "⚠ Claude subscription limits are documented baselines, not guarantees. Community\n" +
  "  reports indicate they can deplete faster than expected on some workloads.\n" +
  "  If your avg is within 20% of a plan limit, expect occasional throttling.";

/** Avg >= 80% of the relevant 5h ceiling flags the plan MARGINAL (technically
 *  fits but no throttling buffer). Hardcoded — the 20% headroom is a usage
 *  buffer to soak up day-to-day volatility, not a knob to tune. */
const MARGIN_THRESHOLD = 0.8;

function fmtLimit(range: [number, number | null] | null): string {
  if (range === null) return "unlimited";
  const [lo, hi] = range;
  return hi === null ? `${lo}+` : `${lo}-${hi}`;
}

function verdict5h(avg: number, range: [number, number | null] | null): string {
  if (range === null) return "unlimited — fits";
  const [lo, hi] = range;
  if (hi === null) {
    // Open-ended baseline (e.g. Max tiers): compare against `lo` only.
    if (avg > lo) {
      const multiple = avg / lo;
      return `EXCEEDS by ${multiple.toFixed(1)}x (avg ${avg.toFixed(1)} > baseline ${lo}+)`;
    }
    if (avg >= MARGIN_THRESHOLD * lo) {
      const pct = Math.round((avg / lo) * 100);
      return `MARGINAL (${pct}% of baseline ${lo}+)`;
    }
    return `FITS comfortably (avg ${avg.toFixed(1)} ≤ baseline ${lo}+)`;
  }
  if (avg > hi) {
    const multiple = avg / hi;
    return `EXCEEDS by ${multiple.toFixed(1)}x (avg ${avg.toFixed(1)} > high bound ${hi})`;
  }
  if (avg >= MARGIN_THRESHOLD * hi) {
    const pct = Math.round((avg / hi) * 100);
    return `MARGINAL (${pct}% of high bound ${hi})`;
  }
  if (avg <= lo) return `FITS comfortably (avg ${avg.toFixed(1)} ≤ low bound ${lo})`;
  return `FITS at high-usage tier (avg ${avg.toFixed(1)} within [${lo}-${hi}])`;
}

type PlanStatusKind = "comfortable" | "marginal" | "exceeds" | "session-blocked";

interface PlanStatus {
  key: string;
  label: string;
  monthlyUsd: number | null;
  verdict: string;
  status: PlanStatusKind;
  /** Percent of the 5h ceiling when status === "marginal", else null. */
  marginalPct: number | null;
  /** Sort key: priced plans ordered ascending; Enterprise (null price) → Infinity. */
  price: number;
}

function classifyPlans(stats: SubscriptionStats, planLimits: Record<string, PlanLimits>): PlanStatus[] {
  const out: PlanStatus[] = [];
  for (const [key, plan] of Object.entries(planLimits)) {
    const verdict = verdict5h(stats.avgPer5h, plan.messagesPer5h);
    let status: PlanStatusKind;
    let marginalPct: number | null = null;
    if (plan.sessionsCap != null && stats.avgSessionsPerMonth > plan.sessionsCap) {
      status = "session-blocked";
    } else if (verdict.startsWith("EXCEEDS")) {
      status = "exceeds";
    } else if (verdict.startsWith("MARGINAL")) {
      status = "marginal";
      const m = verdict.match(/\((\d+)%/);
      if (m) marginalPct = parseInt(m[1], 10);
    } else {
      status = "comfortable";
    }
    out.push({
      key, label: plan.label, monthlyUsd: plan.monthlyUsd,
      verdict, status, marginalPct,
      price: plan.monthlyUsd ?? Infinity,
    });
  }
  return out;
}

interface BestFitRecommendation {
  /** Cheapest comfortable plan (status === "comfortable") — the recommended pick. */
  primary: PlanStatus | null;
  /** Marginal plan cheaper than `primary` — worth flagging ("fits technically but…"). */
  cheaperMarginal: PlanStatus | null;
  /** Cheapest marginal plan when no comfortable plan exists (the least-bad option). */
  marginal: PlanStatus | null;
  /** Pricier plan to suggest for headroom when only `marginal` is available. */
  headroomAlt: PlanStatus | null;
}

/** Pick the plan to recommend. MARGINAL does NOT count as FITS — we prefer a
 *  plan with real buffer. When only a marginal plan is reachable, surface both
 *  it and the next-up headroom option (or Enterprise) so the user sees the
 *  trade-off instead of a silently-tight recommendation. */
function findBestFit(stats: SubscriptionStats, planLimits: Record<string, PlanLimits>): BestFitRecommendation {
  const classified = classifyPlans(stats, planLimits);
  const comfortable = classified.filter(c => c.status === "comfortable").sort((a, b) => a.price - b.price);
  const marginal = classified.filter(c => c.status === "marginal").sort((a, b) => a.price - b.price);

  const primary = comfortable[0] ?? null;
  let cheaperMarginal: PlanStatus | null = null;
  let marginalOnly: PlanStatus | null = null;
  let headroomAlt: PlanStatus | null = null;

  if (primary) {
    // If the cheapest overall option is marginal (below primary's price),
    // flag it so users know the $$$ jump buys buffer, not fit.
    if (marginal.length > 0 && marginal[0].price < primary.price) {
      cheaperMarginal = marginal[0];
    }
  } else if (marginal.length > 0) {
    marginalOnly = marginal[0];
    // Headroom = cheapest plan strictly pricier than the marginal pick that
    // isn't session-blocked. Even an "exceeds" plan is useful context here —
    // it tells the user where to escalate if throttling bites.
    const costlier = classified
      .filter(c => c.price > marginalOnly!.price && c.status !== "session-blocked")
      .sort((a, b) => a.price - b.price);
    headroomAlt = costlier[0] ?? null;
  }

  return { primary, cheaperMarginal, marginal: marginalOnly, headroomAlt };
}

function priceStr(usd: number | null): string {
  return usd === null ? "custom pricing" : `$${usd}/mo`;
}

function primaryReason(p: PlanStatus): string {
  if (p.verdict.startsWith("unlimited")) return "unlimited 5h throughput";
  if (p.verdict.startsWith("FITS at high-usage")) return "fits within high-usage band";
  return "fits below baseline";
}

function renderBestFit(rec: BestFitRecommendation): string {
  if (rec.primary) {
    const base = `→ Best fit: ${rec.primary.label} at ${priceStr(rec.primary.monthlyUsd)}`;
    if (rec.cheaperMarginal) {
      const cm = rec.cheaperMarginal;
      return `${base} — ${cm.label} at ${priceStr(cm.monthlyUsd)} fits technically but you're at ${cm.marginalPct ?? "?"}% of the limit, expect throttling`;
    }
    return `${base} — ${primaryReason(rec.primary)}`;
  }
  if (rec.marginal) {
    const m = rec.marginal;
    const base = `→ ${m.label} ${priceStr(m.monthlyUsd)} MARGINAL (${m.marginalPct ?? "?"}% of limit)`;
    if (rec.headroomAlt) {
      return `${base} — consider ${rec.headroomAlt.label} ${priceStr(rec.headroomAlt.monthlyUsd)} for headroom`;
    }
    return `${base} — no roomier plan available`;
  }
  return "→ No plan comfortably fits — consider Enterprise or reducing usage";
}

function renderSubscriptionSection(stats: SubscriptionStats, planLimits: Record<string, PlanLimits>): string {
  if (stats.totalMessages === 0) return "No messages — subscription comparison skipped.\n";

  const out: string[] = [];
  out.push(`Your usage: ${stats.totalMessages.toLocaleString()} assistant messages over ${stats.daysSpanned.toFixed(1)} days`);
  out.push(`  ≈ ${stats.avgPerDay.toFixed(1)} msgs/day  ≈ ${stats.avgPer5h.toFixed(1)} msgs per 5h window`);
  out.push("");

  const header = ["Plan", "Price/mo", "5h limit", "Fits your avg?", "Note"];
  const body: string[][] = [];
  for (const plan of Object.values(planLimits)) {
    body.push([
      plan.label,
      plan.monthlyUsd === null ? "custom" : `$${plan.monthlyUsd}`,
      fmtLimit(plan.messagesPer5h),
      verdict5h(stats.avgPer5h, plan.messagesPer5h),
      plan.note ?? "",
    ]);
  }
  const sessionsLine = `Sessions: ${stats.totalSessions.toLocaleString()} total over ${stats.monthsSpanned} month(s) (avg ${stats.avgSessionsPerMonth.toFixed(1)}/mo). Max plans cap at ${MAX_SESSIONS_PER_MONTH_CAP} sessions/mo.`;
  const sessionsWarn = stats.avgSessionsPerMonth > MAX_SESSIONS_PER_MONTH_CAP
    ? `  ⚠ EXCEEDS ${MAX_SESSIONS_PER_MONTH_CAP} sessions/mo cap on Claude Max plans`
    : "";
  const bestLine = renderBestFit(findBestFit(stats, planLimits));

  const parts: string[] = [];
  parts.push(out.join("\n"));
  parts.push(renderTable(header, body).join("\n"));
  parts.push("");
  parts.push(sessionsLine);
  if (sessionsWarn) parts.push(sessionsWarn);
  parts.push("");
  parts.push(VOLATILITY_WARNING);
  parts.push("");
  parts.push(bestLine);
  return parts.join("\n") + "\n";
}

function renderMonthlySection(byMonth: Map<string, Map<string, ModelTotals>>, pricing: Record<string, ModelPricing>): string {
  if (byMonth.size === 0) return "No timestamped messages for monthly breakdown.\n";

  const header = ["Month", "Msgs", "In", "Out", "CacheR", "CacheW", "Claude $", "Codex-Std $", "Savings"];
  const codexStd = pricing["codex-standard"] ?? null;
  const months = [...byMonth.keys()].sort();
  const body: string[][] = [];
  let totMsgs = 0, totIn = 0, totOut = 0, totCR = 0, totCW = 0, totClaude = 0, totCodex = 0;

  for (const ym of months) {
    const modelBucket = byMonth.get(ym)!;
    const merged = emptyTotals();
    let costClaude = 0;
    for (const [model, t] of modelBucket) {
      const price = pricing[model];
      merged.inputTokens += t.inputTokens;
      merged.outputTokens += t.outputTokens;
      merged.cacheReadTokens += t.cacheReadTokens;
      merged.cacheCreationTokens += t.cacheCreationTokens;
      merged.messageCount += t.messageCount;
      if (price) costClaude += costOn(price, t);
    }
    const costCodex = codexStd ? costOn(codexStd, merged) : null;
    totMsgs += merged.messageCount;
    totIn += merged.inputTokens;
    totOut += merged.outputTokens;
    totCR += merged.cacheReadTokens;
    totCW += merged.cacheCreationTokens;
    totClaude += costClaude;
    if (costCodex !== null) totCodex += costCodex;
    body.push([
      ym, String(merged.messageCount),
      fmtTokens(merged.inputTokens), fmtTokens(merged.outputTokens),
      fmtTokens(merged.cacheReadTokens), fmtTokens(merged.cacheCreationTokens),
      fmtUsd(costClaude), fmtUsdOrDash(costCodex),
      savingsOrDash(costClaude, costCodex),
    ]);
  }
  body.push([
    "TOTAL", String(totMsgs),
    fmtTokens(totIn), fmtTokens(totOut),
    fmtTokens(totCR), fmtTokens(totCW),
    fmtUsd(totClaude), codexStd ? fmtUsd(totCodex) : "—",
    codexStd && totClaude > 0 ? `${(totCodex / totClaude).toFixed(2)}x` : "—",
  ]);
  return renderTable(header, body).join("\n") + "\n";
}

// ───────────────────────────────────────────────────────────────────────────
// Markdown export (GitHub Flavored Markdown)
// ───────────────────────────────────────────────────────────────────────────

function gfmRow(cells: string[]): string {
  return "| " + cells.join(" | ") + " |";
}
function gfmSep(n: number): string {
  return "|" + " --- |".repeat(n);
}

interface MarkdownInput {
  rows: ModelRow[];
  byMonth: Map<string, Map<string, ModelTotals>>;
  subStats: SubscriptionStats;
  pricing: Record<string, ModelPricing>;
  planLimits: Record<string, PlanLimits>;
  scanPath: string;
  filesScanned: number;
  minTs: string | null;
  maxTs: string | null;
}

export function renderMarkdown(inp: MarkdownInput): string {
  const today = new Date().toISOString().slice(0, 10);
  const firstDate = inp.minTs ? inp.minTs.slice(0, 10) : "n/a";
  const lastDate = inp.maxTs ? inp.maxTs.slice(0, 10) : "n/a";
  const out: string[] = [];

  out.push("## subfit-ai Report — find the plan that fits your usage");
  out.push("");
  out.push(`**Date:** ${today}  `);
  out.push(`**Scanned:** ${inp.filesScanned.toLocaleString()} JSONL file(s) under \`${inp.scanPath}\`  `);
  out.push(`**Session date range:** ${firstDate} → ${lastDate}`);
  out.push("");

  // Monthly table
  out.push("### Monthly breakdown");
  out.push("");
  const codexStd = inp.pricing["codex-standard"];
  if (inp.byMonth.size === 0 || !codexStd) {
    out.push("_No timestamped messages available._");
  } else {
    out.push(gfmRow(["Month", "Tokens In", "Tokens Out", "Claude $", "Codex $"]));
    out.push(gfmSep(5));
    const months = [...inp.byMonth.keys()].sort();
    let totIn = 0, totOut = 0, totC = 0, totX = 0;
    for (const ym of months) {
      const bucket = inp.byMonth.get(ym)!;
      const merged = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, messageCount: 0 };
      let costClaude = 0;
      for (const [model, t] of bucket) {
        const p = inp.pricing[model];
        merged.inputTokens += t.inputTokens;
        merged.outputTokens += t.outputTokens;
        merged.cacheReadTokens += t.cacheReadTokens;
        merged.cacheCreationTokens += t.cacheCreationTokens;
        if (p) costClaude += costOn(p, t);
      }
      const costCodex = costOn(codexStd, merged);
      totIn += merged.inputTokens; totOut += merged.outputTokens;
      totC += costClaude; totX += costCodex;
      out.push(gfmRow([ym, fmtTokens(merged.inputTokens), fmtTokens(merged.outputTokens), fmtUsd(costClaude), fmtUsd(costCodex)]));
    }
    out.push(gfmRow(["**TOTAL**", `**${fmtTokens(totIn)}**`, `**${fmtTokens(totOut)}**`, `**${fmtUsd(totC)}**`, `**${fmtUsd(totX)}**`]));
  }
  out.push("");

  // Per-model table
  out.push("### Per model");
  out.push("");
  if (inp.rows.length === 0) {
    out.push("_No assistant messages with usage found._");
  } else {
    out.push(gfmRow(["Model", "Msgs", "Input", "Output", "Cache R", "Cache W", "Claude $", "Codex Std $", "Codex Pri $", "Savings"]));
    out.push(gfmSep(10));
    for (const r of inp.rows) {
      out.push(gfmRow([
        r.label, String(r.totals.messageCount),
        fmtTokens(r.totals.inputTokens), fmtTokens(r.totals.outputTokens),
        fmtTokens(r.totals.cacheReadTokens), fmtTokens(r.totals.cacheCreationTokens),
        fmtUsd(r.costClaude), fmtUsdOrDash(r.costCodexStandard), fmtUsdOrDash(r.costCodexPriority),
        savingsOrDash(r.costClaude, r.costCodexStandard),
      ]));
    }
  }
  out.push("");

  // Subscription fit
  out.push("### Subscription Fit");
  out.push("");
  if (inp.subStats.totalMessages === 0) {
    out.push("_No messages — subscription comparison skipped._");
  } else {
    out.push(`Your usage: **${inp.subStats.totalMessages.toLocaleString()}** assistant messages over **${inp.subStats.daysSpanned.toFixed(1)}** days  `);
    out.push(`≈ **${inp.subStats.avgPerDay.toFixed(1)}** msgs/day  ≈ **${inp.subStats.avgPer5h.toFixed(1)}** msgs per 5-hour window`);
    out.push("");
    out.push(gfmRow(["Plan", "Price/mo", "5h limit", "Fits your avg?", "Note"]));
    out.push(gfmSep(5));
    for (const plan of Object.values(inp.planLimits)) {
      out.push(gfmRow([
        plan.label,
        plan.monthlyUsd === null ? "custom" : `$${plan.monthlyUsd}`,
        fmtLimit(plan.messagesPer5h),
        verdict5h(inp.subStats.avgPer5h, plan.messagesPer5h),
        plan.note ?? "",
      ]));
    }
    out.push("");
    out.push(`**Sessions:** ${inp.subStats.totalSessions.toLocaleString()} total over ${inp.subStats.monthsSpanned} month(s) (avg **${inp.subStats.avgSessionsPerMonth.toFixed(1)}/mo**). Max plans cap at ${MAX_SESSIONS_PER_MONTH_CAP} sessions/mo.`);
    if (inp.subStats.avgSessionsPerMonth > MAX_SESSIONS_PER_MONTH_CAP) {
      out.push("");
      out.push(`> ⚠ EXCEEDS ${MAX_SESSIONS_PER_MONTH_CAP} sessions/mo cap on Claude Max plans`);
    }
    out.push("");
    out.push("> ⚠ Claude subscription limits are documented baselines, not guarantees.");
    out.push("> Community reports indicate they can deplete faster than expected on some");
    out.push("> workloads. If your avg is within 20% of a plan limit, expect occasional throttling.");
    out.push("");
    const best = findBestFit(inp.subStats, inp.planLimits);
    out.push(`**${renderBestFit(best)}**`);
  }
  out.push("");

  out.push("---");
  out.push(`Generated by subfit-ai on ${today}`);
  out.push("");
  return out.join("\n");
}

// ───────────────────────────────────────────────────────────────────────────
// Main
// ───────────────────────────────────────────────────────────────────────────

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); return 0; }

  // M3 — warn once per run about unrecognized tokens, then continue.
  if (args.unknownFlags.length > 0) {
    process.stderr.write(`subfit-ai: unknown arg(s) ignored: ${args.unknownFlags.join(" ")}\n`);
    process.stderr.write(`  (run with --help to see supported options)\n`);
  }

  if (!existsSync(args.path)) {
    process.stderr.write(`subfit-ai: path not found: ${args.path}\n`);
    process.stderr.write(`  (use --path to point somewhere else, or --help)\n`);
    return 1;
  }

  const { config, source: configSource } = loadConfig(args.config ?? undefined);
  const { pricing, planLimits } = config;

  const files = findJsonlFiles(args.path);
  const ctx: ScanContext = {
    byModel: new Map(),
    byMonth: new Map(),
    minTs: null, maxTs: null,
    totalLines: 0, assistantLines: 0, withUsage: 0, parseErrors: 0,
    unknownModels: new Set(),
  };
  for (const f of files) scanJsonl(f, ctx);

  // M1 — warn when model strings didn't match any known bucket (bucketed as Opus).
  if (ctx.unknownModels.size > 0) {
    const list = [...ctx.unknownModels].sort().join(", ");
    process.stderr.write(`subfit-ai: unrecognized model id(s) bucketed as Claude Opus: ${list}\n`);
    process.stderr.write(`  (update normalizeModel() or config.pricing to add a proper bucket)\n`);
  }

  const rows = computeRows(ctx.byModel, pricing);
  const subStats = computeSubscriptionStats(
    ctx.assistantLines,
    ctx.minTs,
    ctx.maxTs,
    files.length,        // 1 JSONL file ≈ 1 Claude session
    ctx.byMonth.size,    // distinct YYYY-MM buckets with data
  );
  // M2 — subscription verdicts also surfaced in JSON output.
  const subscriptionVerdicts = Object.fromEntries(
    Object.entries(planLimits).map(([k, plan]) => [k, {
      plan: plan.label,
      monthlyUsd: plan.monthlyUsd,
      messagesPer5h: plan.messagesPer5h,
      sessionsCap: plan.sessionsCap ?? null,
      note: plan.note ?? null,
      verdict: verdict5h(subStats.avgPer5h, plan.messagesPer5h),
      sessionCapExceeded: plan.sessionsCap != null && subStats.avgSessionsPerMonth > plan.sessionsCap,
    }]),
  );
  const bestFit = findBestFit(subStats, planLimits);
  // `price` is an internal sort key (Infinity for Enterprise → null in JSON).
  // Strip it so machine consumers see a clean shape.
  const stripPrice = (p: PlanStatus | null) => {
    if (!p) return null;
    const { price, ...rest } = p;
    void price;
    return rest;
  };
  const bestFitPayload = {
    primary: stripPrice(bestFit.primary),
    cheaperMarginal: stripPrice(bestFit.cheaperMarginal),
    marginal: stripPrice(bestFit.marginal),
    headroomAlt: stripPrice(bestFit.headroomAlt),
  };

  if (args.json) {
    const payload = {
      path: args.path,
      configSource,
      filesScanned: files.length,
      dateRange: { first: ctx.minTs, last: ctx.maxTs },
      stats: {
        totalLines: ctx.totalLines,
        assistantLines: ctx.assistantLines,
        withUsage: ctx.withUsage,
        parseErrors: ctx.parseErrors,
      },
      unknownModels: [...ctx.unknownModels].sort(),
      pricing,
      planLimits,
      subscriptionStats: subStats,
      subscriptionVerdicts,
      bestFit: bestFitPayload,
      byModel: rows,
      byMonth: Object.fromEntries(
        [...ctx.byMonth.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([ym, bucket]) => [
          ym,
          Object.fromEntries([...bucket.entries()]),
        ]),
      ),
    };
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    // Allow --export alongside --json
    if (args.exportPath) {
      const target = args.exportPath;
      if (existsSync(target)) process.stderr.write(`subfit-ai: overwriting existing file ${target}\n`);
      try {
        const md = renderMarkdown({
          rows, byMonth: ctx.byMonth, subStats,
          pricing, planLimits,
          scanPath: args.path, filesScanned: files.length,
          minTs: ctx.minTs, maxTs: ctx.maxTs,
        });
        writeFileSync(target, md, "utf-8");
        process.stderr.write(`subfit-ai: report written to ${target}\n`);
      } catch (err: any) {
        process.stderr.write(`subfit-ai: failed to write ${target}: ${err?.message ?? err}\n`);
        return 1;
      }
    }
    return 0;
  }

  const firstDate = ctx.minTs ? ctx.minTs.slice(0, 10) : "n/a";
  const lastDate = ctx.maxTs ? ctx.maxTs.slice(0, 10) : "n/a";

  const out: string[] = [];
  out.push(`Scanned ${files.length} JSONL file(s) under ${args.path}`);
  out.push(`  config: ${configSource === "fallback" ? "embedded defaults" : configSource}`);
  out.push(`  lines: ${ctx.totalLines.toLocaleString()}  assistant: ${ctx.assistantLines.toLocaleString()}  with-usage: ${ctx.withUsage.toLocaleString()}  parse-errors: ${ctx.parseErrors}`);
  out.push(`  date range: ${firstDate} → ${lastDate}`);
  out.push("");
  // Lead with the subscription verdict (the question users actually came for);
  // the per-model / per-month tables follow as supporting evidence.
  out.push("── Subscription comparison ──");
  out.push(renderSubscriptionSection(subStats, planLimits));
  out.push("── Per model ──");
  out.push(renderModelSection(rows));
  if (args.monthly) {
    out.push("── Per month ──");
    out.push(renderMonthlySection(ctx.byMonth, pricing));
  }
  out.push("Savings column: how many times the same tokens would have cost on Codex standard vs the Claude model that produced them.");
  out.push(">1.0 = Claude is cheaper. <1.0 = Codex is cheaper.");
  process.stdout.write(out.join("\n") + "\n");

  // --export: write GFM markdown report alongside the terminal output
  if (args.exportPath) {
    const target = args.exportPath;
    if (existsSync(target)) {
      process.stderr.write(`subfit-ai: overwriting existing file ${target}\n`);
    }
    try {
      const md = renderMarkdown({
        rows, byMonth: ctx.byMonth, subStats,
        pricing, planLimits,
        scanPath: args.path, filesScanned: files.length,
        minTs: ctx.minTs, maxTs: ctx.maxTs,
      });
      writeFileSync(target, md, "utf-8");
      process.stderr.write(`subfit-ai: report written to ${target}\n`);
    } catch (err: any) {
      process.stderr.write(`subfit-ai: failed to write ${target}: ${err?.message ?? err}\n`);
      return 1;
    }
  }
  return 0;
}

// Run only when invoked directly — allow `import` for tests.
const invokedAs = process.argv[1] ? process.argv[1] : "";
if (invokedAs && (invokedAs.endsWith("/subfit-ai.ts") || invokedAs.endsWith("/subfit-ai.mjs") || invokedAs.endsWith("/subfit-ai.js") || invokedAs.endsWith("/subfit-ai"))) {
  process.exit(main());
}

export { parseArgs, FALLBACK_CONFIG, verdict5h, findBestFit, classifyPlans, MARGIN_THRESHOLD };
export type { BestFitRecommendation, PlanStatus };
