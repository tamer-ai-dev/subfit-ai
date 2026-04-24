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
import { join, dirname, relative, isAbsolute } from "node:path";
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
   * Messages per 5-hour window. This is also the quantity the downgrade
   * simulation measures against: Anthropic rate-limits by message count,
   * not by tokens (cache-reads especially don't count as new requests).
   *   null             → truly unlimited (rate-limited only; e.g. Enterprise).
   *   [lo, hi]         → fixed band; verdict compares against both bounds.
   *                      Simulation uses `hi` as the effective cap.
   *   [lo, null]       → "lo+" baseline with no published ceiling; verdict
   *                      compares against `lo` only (Claude Max tiers).
   *                      Simulation uses `lo` as the effective cap.
   */
  messagesPer5h: [number, number | null] | null;
  /** Max sessions (~distinct JSONL files) per month; null = no session cap. */
  sessionsCap?: number | null;
  /** Monthly message cap used by the monthly-quota simulation. Plans
   *  without a published monthly message ceiling (or that meter on
   *  sessions/tokens instead) omit this. Calendar-month aggregation
   *  dedups events by requestId — same accounting as the 5h sim. */
  monthlyMsgCap?: number | null;
  /** Human-readable unit label for monthlyMsgCap (default "msgs").
   *  Copilot tiers use "premium req" because their cap meters on
   *  premium-request tokens, not Claude-style assistant messages —
   *  the two units are NOT 1:1 and a disclaimer is printed whenever
   *  any non-default unit appears. */
  monthlyCapUnit?: string;
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
  /** Root to scan for Gemini CLI sessions (~/.gemini by default). Skipped silently if missing. */
  geminiPath: string;
  /** Root to scan for Mistral Vibe CLI sessions (~/.vibe or $VIBE_HOME). Skipped silently if missing. */
  vibePath: string;
  /** Root to scan for OpenAI Codex CLI sessions (~/.codex or $CODEX_HOME). Skipped silently if missing. */
  codexPath: string;
  /** Root to scan for OpenCode CLI sessions (~/.local/share/opencode or $OPENCODE_HOME). Skipped silently if missing. */
  opencodePath: string;
  json: boolean;
  help: boolean;
  monthly: boolean;
  config: string | null;
  /** null = no export, "" placeholder = user wrote --export without value, else path */
  exportPath: string | null;
  /** Unrecognized tokens — main() emits stderr warnings so tests can inspect parsing in isolation. */
  unknownFlags: string[];
  /** When true, main() scans examples/sample.jsonl next to the script instead of --path. */
  demo: boolean;
  /** When true, main() prints the package version and exits. */
  version: boolean;
  /** Allow --export to overwrite an existing target. Without this flag the
   *  run aborts rather than silently clobber a report. */
  force: boolean;
}

/** Read `version` from package.json sitting next to the script. Returns "unknown"
 *  if the file is missing / unreadable so --version never crashes. */
function readVersion(): string {
  try {
    const raw = readFileSync(join(scriptDir(), "package.json"), "utf-8");
    const parsed = JSON.parse(raw);
    return typeof parsed?.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

const DEFAULT_EXPORT_PATH = "subfit-report.md";

function parseArgs(argv: string[]): Args {
  const args: Args = {
    path: join(homedir(), ".claude"),
    geminiPath: join(homedir(), ".gemini"),
    vibePath: process.env.VIBE_HOME ?? join(homedir(), ".vibe"),
    codexPath: process.env.CODEX_HOME ?? join(homedir(), ".codex"),
    opencodePath: process.env.OPENCODE_HOME ?? join(homedir(), ".local/share/opencode"),
    json: false,
    help: false,
    monthly: true,
    config: null,
    exportPath: null,
    unknownFlags: [],
    demo: false,
    version: false,
    force: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--version" || a === "-v") args.version = true;
    else if (a === "--json") args.json = true;
    else if (a === "--demo") args.demo = true;
    else if (a === "--force") args.force = true;
    else if (a === "--no-monthly") args.monthly = false;
    else if (a === "--path") args.path = argv[++i] ?? args.path;
    else if (a.startsWith("--path=")) args.path = a.slice("--path=".length);
    else if (a === "--gemini-path") args.geminiPath = argv[++i] ?? args.geminiPath;
    else if (a.startsWith("--gemini-path=")) args.geminiPath = a.slice("--gemini-path=".length);
    else if (a === "--vibe-path") args.vibePath = argv[++i] ?? args.vibePath;
    else if (a.startsWith("--vibe-path=")) args.vibePath = a.slice("--vibe-path=".length);
    else if (a === "--codex-path") args.codexPath = argv[++i] ?? args.codexPath;
    else if (a.startsWith("--codex-path=")) args.codexPath = a.slice("--codex-path=".length);
    else if (a === "--opencode-path") args.opencodePath = argv[++i] ?? args.opencodePath;
    else if (a.startsWith("--opencode-path=")) args.opencodePath = a.slice("--opencode-path=".length);
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
  --gemini-path <dir>
                  Root directory holding Gemini CLI sessions (default: ~/.gemini).
                  Scans tmp/<slug>/chats/session-*.json. Skipped silently if the
                  directory does not exist.
  --vibe-path <dir>
                  Root directory holding Mistral Vibe CLI sessions (default:
                  $VIBE_HOME or ~/.vibe). Scans logs/**/*.{json,jsonl}. Skipped
                  silently if the directory does not exist.
  --codex-path <dir>
                  Root directory holding OpenAI Codex CLI sessions (default:
                  $CODEX_HOME or ~/.codex). Scans sessions/** and history/**
                  for *.{json,jsonl}. Skipped silently if missing.
  --opencode-path <dir>
                  Root directory holding OpenCode CLI sessions (default:
                  $OPENCODE_HOME or ~/.local/share/opencode). Scans
                  storage/session/**/ses_*.json. OpenCode is BYOK, so each
                  turn is priced by the upstream provider it routed to
                  (Claude / Gemini / Codex / Mistral). Skipped silently if
                  the directory does not exist.
  --config <file> Path to a pricing/plan-limits JSON (default:
                  <script-dir>/config.json; falls back to built-in defaults
                  if the file is missing or malformed).
  --json          Emit machine-readable JSON instead of a terminal table.
  --no-monthly    Skip the monthly breakdown (per-model table only).
  --export [file] Write a Markdown (GFM) report. If no file is given, defaults
                  to ./subfit-report.md. REFUSES to overwrite an existing
                  file unless --force is also passed. Can be combined with
                  normal terminal output.
  --force         Allow --export to overwrite an existing target file.
  --demo          Scan examples/sample.jsonl bundled with this script instead
                  of --path. Useful for trying the tool without Claude Code.
  -v, --version   Print the package version and exit.
  -h, --help      Show this help.

LIMITS
  Individual session files larger than 50 MB are skipped with a stderr
  warning to prevent OOM on oversized or poisoned inputs.

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

/** Per-file size ceiling. A real Claude / Gemini session file stays well
 *  under this (session JSONL caps out around a few MB in practice); a
 *  50 MB file is almost certainly log pollution or an attempt to OOM the
 *  process. Oversized files are skipped with a stderr warning. */
const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** Strip ASCII and C1 control characters from a string before emitting it to
 *  a TTY. Untrusted wire-model IDs could otherwise carry escape sequences
 *  (cursor moves, colour codes, terminal-title rewrites) that execute when
 *  printed. Newline (0x0A) is preserved so multi-line contexts still work.
 *  Everything < 0x20 (except 0x0A) plus the C1 block (0x7F-0x9F) is stripped. */
export function sanitizeForTerminal(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x09\x0B-\x1F\x7F-\x9F]/g, "");
}

function fileTooLarge(filePath: string): boolean {
  let size: number;
  try { size = statSync(filePath).size; } catch { return false; }
  if (size <= MAX_FILE_BYTES) return false;
  const mb = (size / 1024 / 1024).toFixed(1);
  const capMb = (MAX_FILE_BYTES / 1024 / 1024).toFixed(0);
  process.stderr.write(`subfit-ai: skipping ${filePath} (${mb} MB > ${capMb} MB cap)\n`);
  return true;
}

/** Maximum directory depth for recursive scans. A real `~/.claude` tree is
 *  only a few levels deep (projects/<slug>/sessionId.jsonl), so 10 levels
 *  is well past any legitimate layout. Deeper paths are skipped to prevent
 *  unbounded traversal from symlink loops or poisoned directory trees. */
const MAX_SCAN_DEPTH = 10;

/** Walk root recursively, return every *.jsonl file path. Guards against
 *  cycles, unreadable dirs, and traversal explosions (MAX_SCAN_DEPTH). */
export function findJsonlFiles(root: string): string[] {
  const files: string[] = [];
  if (!existsSync(root)) return files;

  const seen = new Set<string>();
  const stack: Array<[string, number]> = [[root, 0]];
  let depthExceeded = false;

  while (stack.length > 0) {
    const [dir, depth] = stack.pop()!;
    if (seen.has(dir)) continue;
    seen.add(dir);
    if (depth > MAX_SCAN_DEPTH) { depthExceeded = true; continue; }

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
      if (sub.isDirectory()) stack.push([p, depth + 1]);
      else if (sub.isFile() && name.endsWith(".jsonl")) files.push(p);
    }
  }
  if (depthExceeded) {
    process.stderr.write(`subfit-ai: scan depth cap (${MAX_SCAN_DEPTH}) reached under ${root}; deeper directories skipped\n`);
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

/** One priced assistant turn, kept for rolling-window analysis.
 *  Populated only when the turn has BOTH a usable ISO timestamp AND a
 *  usage block — those are the only turns we can place on a timeline
 *  and attribute to a 5h window. */
export interface ScanEvent {
  /** ISO 8601 timestamp lexicographically comparable. */
  ts: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Source CLI. Lets the windowing layer slice per-provider if needed. */
  provider: "claude" | "gemini" | "vibe" | "codex" | "opencode";
  /** Normalised pricing key (same key as ScanContext.byModel). */
  model: string;
  /** Anthropic API request id when present (Claude JSONL's `requestId`
   *  field). Claude Code writes one JSONL line per streamed content
   *  block, so a single API response can produce several events that
   *  share a requestId — the windowing layer dedups on this to match
   *  Anthropic's per-request rate-limit accounting. Undefined for
   *  providers that don't emit it (Gemini/Vibe/Codex/OpenCode). */
  requestId?: string;
}

interface ScanContext {
  byModel: Map<string, ModelTotals>;
  byMonth: Map<string, Map<string, ModelTotals>>;
  minTs: string | null;
  maxTs: string | null;
  /** Per-turn timeline for 5h-window analysis. Unsorted during scan;
   *  callers that need ordered access should invoke sortEvents() once. */
  events: ScanEvent[];
  totalLines: number;
  assistantLines: number;
  withUsage: number;
  parseErrors: number;
  /** Claude wire names (from JSONL scanner) that didn't match haiku/sonnet/opus. */
  unknownClaudeModels: Set<string>;
  /** Gemini wire names (from session-JSON scanner) that didn't match pro/flash/flash-lite. */
  unknownGeminiModels: Set<string>;
  /** Vibe wire names (from Mistral Vibe scanner) that didn't match devstral*. */
  unknownVibeModels: Set<string>;
  /** Codex wire names (from OpenAI Codex scanner) that didn't match the codex / gpt-5 families. */
  unknownCodexModels: Set<string>;
  /** Model strings from OpenCode sessions that couldn't be routed to any known provider family. */
  unknownOpenCodeModels: Set<string>;
}

function emptyScanContext(): ScanContext {
  return {
    byModel: new Map(),
    byMonth: new Map(),
    minTs: null, maxTs: null,
    events: [],
    totalLines: 0, assistantLines: 0, withUsage: 0, parseErrors: 0,
    unknownClaudeModels: new Set(),
    unknownGeminiModels: new Set(),
    unknownVibeModels: new Set(),
    unknownCodexModels: new Set(),
    unknownOpenCodeModels: new Set(),
  };
}

/** Sort a ScanEvent list ascending by timestamp. 5h-window bucketing
 *  assumes ordered input; scanning appends in file-walk order which is
 *  not guaranteed monotonic. Stable, mutates in place. */
export function sortEvents(events: ScanEvent[]): ScanEvent[] {
  events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return events;
}

/** Merge two scan contexts into a new one. Per-provider scanning fills its own
 *  ScanContext so the summary table can show per-provider stats; downstream
 *  costing logic operates on the merged result. Counters add; date bounds
 *  extend; per-provider unknown-model sets union; byModel / byMonth totals
 *  are summed per key. */
function mergeContexts(a: ScanContext, b: ScanContext): ScanContext {
  const out = emptyScanContext();
  out.totalLines     = a.totalLines     + b.totalLines;
  out.assistantLines = a.assistantLines + b.assistantLines;
  out.withUsage      = a.withUsage      + b.withUsage;
  out.parseErrors    = a.parseErrors    + b.parseErrors;
  out.minTs = a.minTs && b.minTs ? (a.minTs < b.minTs ? a.minTs : b.minTs) : (a.minTs ?? b.minTs);
  out.maxTs = a.maxTs && b.maxTs ? (a.maxTs > b.maxTs ? a.maxTs : b.maxTs) : (a.maxTs ?? b.maxTs);
  // Concatenate events — sort is deferred to the windowing caller so
  // merges stay O(n) and we pay the O(n log n) sort cost only once.
  out.events = a.events.concat(b.events);

  const foldTotals = (dst: ModelTotals, t: ModelTotals) => {
    dst.inputTokens        += t.inputTokens;
    dst.outputTokens       += t.outputTokens;
    dst.cacheReadTokens    += t.cacheReadTokens;
    dst.cacheCreationTokens += t.cacheCreationTokens;
    dst.messageCount       += t.messageCount;
  };

  for (const src of [a, b]) {
    for (const m of src.unknownClaudeModels) out.unknownClaudeModels.add(m);
    for (const m of src.unknownGeminiModels) out.unknownGeminiModels.add(m);
    for (const m of src.unknownVibeModels)   out.unknownVibeModels.add(m);
    for (const m of src.unknownCodexModels)  out.unknownCodexModels.add(m);
    for (const m of src.unknownOpenCodeModels) out.unknownOpenCodeModels.add(m);
    for (const [model, t] of src.byModel) {
      const cur = out.byModel.get(model);
      if (!cur) out.byModel.set(model, { ...t });
      else foldTotals(cur, t);
    }
    for (const [ym, bucket] of src.byMonth) {
      let mm = out.byMonth.get(ym);
      if (!mm) { mm = new Map(); out.byMonth.set(ym, mm); }
      for (const [model, t] of bucket) {
        const cur = mm.get(model);
        if (!cur) mm.set(model, { ...t });
        else foldTotals(cur, t);
      }
    }
  }
  return out;
}

/** Per-provider snapshot used to render the "Scan summary" table.
 *  `entries` is the total count of parsed items in the transcript —
 *  non-blank lines for JSONL (Claude), message-array entries for the
 *  JSON-shape providers (Gemini, Vibe, Codex). Works as a single
 *  comparable column across providers regardless of on-disk format. */
interface ProviderStats {
  name: string;
  files: number;
  entries: number;
  messages: number;
  withTokens: number;
  parseErrors: number;
  minTs: string | null;
  maxTs: string | null;
}

function providerStatsOf(name: string, files: number, ctx: ScanContext): ProviderStats {
  return {
    name, files,
    entries: ctx.totalLines,
    messages: ctx.assistantLines,
    withTokens: ctx.withUsage,
    parseErrors: ctx.parseErrors,
    minTs: ctx.minTs,
    maxTs: ctx.maxTs,
  };
}

function scanJsonl(filePath: string, ctx: ScanContext): void {
  if (fileTooLarge(filePath)) return;
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
    if (!matched && typeof rawModel === "string" && rawModel) ctx.unknownClaudeModels.add(rawModel);
    const ts: string | undefined = obj.timestamp;
    if (ts && (!ctx.minTs || ts < ctx.minTs)) ctx.minTs = ts;
    if (ts && (!ctx.maxTs || ts > ctx.maxTs)) ctx.maxTs = ts;

    const inTok   = u.input_tokens ?? 0;
    const outTok  = u.output_tokens ?? 0;
    const crTok   = u.cache_read_input_tokens ?? 0;
    const cwTok   = u.cache_creation_input_tokens ?? 0;
    const reqId   = typeof obj.requestId === "string" ? obj.requestId : undefined;
    if (ts) ctx.events.push({
      ts, inputTokens: inTok, outputTokens: outTok,
      cacheReadTokens: crTok, cacheCreationTokens: cwTok,
      provider: "claude", model, requestId: reqId,
    });

    const addInto = (t: ModelTotals) => {
      t.inputTokens += inTok;
      t.outputTokens += outTok;
      t.cacheReadTokens += crTok;
      t.cacheCreationTokens += cwTok;
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
// Gemini CLI session scanner. Gemini persists one JSON object per session
// under ~/.gemini/tmp/<slug>/chats/session-*.json — NOT JSONL. Each session
// carries a `messages` array where assistant turns have `type: "gemini"` and
// a `tokens` block with `input` / `output` / `cached` counts. See
// docs/studies/STUDY-gemini-tokens.md for the full format.
// ───────────────────────────────────────────────────────────────────────────

/** Walk the Gemini CLI root and return every `session-*.json` file under
 *  `tmp/<slug>/chats/`. Returns an empty list if `root` doesn't exist so
 *  callers can skip Gemini silently when the CLI was never installed.
 *
 *  Traversal is fixed-depth (root → tmp → slug → chats → file = 4 levels),
 *  well under MAX_SCAN_DEPTH, so no explicit depth cap is enforced here —
 *  the layout itself bounds the walk. */
export function findGeminiSessions(root: string): string[] {
  const files: string[] = [];
  if (!existsSync(root)) return files;

  const tmpDir = join(root, "tmp");
  let slugs: string[];
  try { slugs = readdirSync(tmpDir); } catch { return files; }

  for (const slug of slugs) {
    const chatsDir = join(tmpDir, slug, "chats");
    let entries: string[];
    try { entries = readdirSync(chatsDir); } catch { continue; }
    for (const name of entries) {
      if (name.startsWith("session-") && name.endsWith(".json")) {
        files.push(join(chatsDir, name));
      }
    }
  }
  return files;
}

/** Gemini wire id → PRICING key. The matching order matters: "flash-lite"
 *  must be tested before "flash" since the latter is a substring of the
 *  former. Concrete wire names verified:
 *
 *    gemini-2.5-pro, gemini-3-pro-preview                → gemini-pro
 *    gemini-2.5-flash, gemini-3-flash-preview            → gemini-flash
 *    gemini-2.5-flash-lite, gemini-3-flash-lite-preview  → gemini-flash-lite
 *
 *  Unknown strings fall back to gemini-pro with matched:false so main()
 *  warns once per run, matching the Claude side's behavior. */
export function normalizeGeminiModel(m: string | undefined): { key: string; matched: boolean } {
  if (!m) return { key: "gemini-pro", matched: false };
  const low = m.toLowerCase();
  if (low.includes("flash-lite")) return { key: "gemini-flash-lite", matched: true };
  if (low.includes("flash")) return { key: "gemini-flash", matched: true };
  if (low.includes("pro")) return { key: "gemini-pro", matched: true };
  return { key: "gemini-pro", matched: false };
}

/** Parse a single Gemini session JSON file and fold its assistant turns into
 *  the shared ScanContext. Silently skips files that fail to parse so one bad
 *  session doesn't abort the whole run. Counters align with scanJsonl: each
 *  assistant turn bumps assistantLines; turns with a `tokens` block bump
 *  withUsage. Gemini has no cache-write tier, so cacheCreationTokens stays 0. */
export function scanGeminiSession(filePath: string, ctx: ScanContext): void {
  if (fileTooLarge(filePath)) return;
  let content: string;
  try { content = readFileSync(filePath, "utf-8"); }
  catch { return; }

  let session: any;
  try { session = JSON.parse(content); } catch { ctx.parseErrors++; return; }

  const messages = Array.isArray(session?.messages) ? session.messages : [];
  for (const msg of messages) {
    // Every entry in the array is one "entry" for the Scan summary table;
    // assistantLines counts only the turns we ultimately price.
    ctx.totalLines++;
    if (msg?.type !== "gemini") continue;
    ctx.assistantLines++;
    const tokens = msg.tokens;
    if (!tokens) continue;
    ctx.withUsage++;

    const rawModel = msg.model;
    const { key: model, matched } = normalizeGeminiModel(rawModel);
    if (!matched && typeof rawModel === "string" && rawModel) ctx.unknownGeminiModels.add(rawModel);

    const ts: string | undefined = msg.timestamp;
    if (ts && (!ctx.minTs || ts < ctx.minTs)) ctx.minTs = ts;
    if (ts && (!ctx.maxTs || ts > ctx.maxTs)) ctx.maxTs = ts;

    const inTok  = tokens.input ?? 0;
    const outTok = tokens.output ?? 0;
    const crTok  = tokens.cached ?? 0;
    if (ts) ctx.events.push({
      ts, inputTokens: inTok, outputTokens: outTok,
      cacheReadTokens: crTok, cacheCreationTokens: 0,
      provider: "gemini", model,
    });

    const addInto = (t: ModelTotals) => {
      t.inputTokens += inTok;
      t.outputTokens += outTok;
      t.cacheReadTokens += crTok;
      // Gemini has no cache-write equivalent; leave cacheCreationTokens alone.
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
// Mistral Vibe CLI session scanner. Format is [UNVERIFIED] at time of
// writing — Vibe was not installed on the authoring machine. See
// docs/studies/STUDY-vibe-tokens.md for the research that shaped this
// adapter. The scanner is permissive by design: it accepts both a full
// JSON object (with a messages/turns/history array) AND line-by-line
// JSONL, and probes multiple common assistant-turn shapes. The source
// of truth remains the open-source Vibe repo
// (https://github.com/mistralai/mistral-vibe); a contributor with a real
// install should tighten the parsing once the format is pinned.
// ───────────────────────────────────────────────────────────────────────────

/** Walk Vibe root, return every `.json` / `.jsonl` file under `logs/`
 *  (recursively, capped at MAX_SCAN_DEPTH). Returns [] when root or
 *  root/logs is missing so the caller skips Vibe silently. */
export function findVibeSessions(root: string): string[] {
  const files: string[] = [];
  if (!existsSync(root)) return files;
  const logsDir = join(root, "logs");
  if (!existsSync(logsDir)) return files;

  const seen = new Set<string>();
  const stack: Array<[string, number]> = [[logsDir, 0]];
  while (stack.length > 0) {
    const [dir, depth] = stack.pop()!;
    if (seen.has(dir)) continue;
    seen.add(dir);
    if (depth > MAX_SCAN_DEPTH) continue;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      const p = join(dir, name);
      let sub;
      try { sub = statSync(p); } catch { continue; }
      if (sub.isDirectory()) stack.push([p, depth + 1]);
      else if (sub.isFile() && (name.endsWith(".json") || name.endsWith(".jsonl"))) files.push(p);
    }
  }
  return files;
}

/** Vibe wire id → PRICING key. "small" must be checked before the generic
 *  "devstral" fallback since "devstral-small-2" also contains "devstral".
 *  Unknown strings fall back to `devstral-2` with `matched: false` so
 *  main() can warn once per run. */
export function normalizeVibeModel(m: string | undefined): { key: string; matched: boolean } {
  if (!m) return { key: "devstral-2", matched: false };
  const low = m.toLowerCase();
  if (low.includes("small")) return { key: "devstral-small-2", matched: true };
  if (low.includes("devstral")) return { key: "devstral-2", matched: true };
  return { key: "devstral-2", matched: false };
}

/** Parse one Vibe session file and fold its assistant turns into the shared
 *  ScanContext. The file may be a full JSON object (with a
 *  `messages`/`turns`/`history` array), a single JSON turn, or JSONL — we
 *  try JSON first and fall back to line-by-line on parse failure.
 *
 *  For each candidate turn, we accept the most common assistant-role shapes:
 *    { role: "assistant", usage: {...} }
 *    { type: "assistant", usage: {...} }     (Claude-style)
 *    { type: "vibe", usage: {...} }          (mirrors Gemini's type: "gemini")
 *    { role: "assistant", message: { usage: {...} } }
 *  Token mapping follows the Mistral Chat Completions API shape
 *  (prompt_tokens / completion_tokens) with Claude / Gemini fallbacks for
 *  forgiveness. Devstral has no documented cache-write tier. */
export function scanVibeSession(filePath: string, ctx: ScanContext): void {
  if (fileTooLarge(filePath)) return;
  let content: string;
  try { content = readFileSync(filePath, "utf-8"); }
  catch { return; }

  // Try full-file JSON first; fall back to JSONL if that fails.
  let turns: any[] = [];
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) turns = parsed;
    else if (Array.isArray(parsed?.messages)) turns = parsed.messages;
    else if (Array.isArray(parsed?.turns)) turns = parsed.turns;
    else if (Array.isArray(parsed?.history)) turns = parsed.history;
    else turns = [parsed];
  } catch {
    for (const raw of content.split("\n")) {
      if (!raw) continue;
      try { turns.push(JSON.parse(raw)); } catch { ctx.parseErrors++; }
    }
    if (turns.length === 0) return;
  }

  for (const turn of turns) {
    // Count every entry in the transcript; assistantLines counts only the
    // turns we price downstream.
    ctx.totalLines++;
    const isAssistant =
      turn?.role === "assistant" ||
      turn?.type === "assistant" ||
      turn?.type === "vibe";
    if (!isAssistant) continue;
    ctx.assistantLines++;

    const usage = turn.usage ?? turn.message?.usage ?? turn.tokens;
    if (!usage) continue;
    ctx.withUsage++;

    const rawModel = turn.model ?? turn.message?.model;
    const { key: model, matched } = normalizeVibeModel(rawModel);
    if (!matched && typeof rawModel === "string" && rawModel) ctx.unknownVibeModels.add(rawModel);

    const ts: string | undefined = turn.timestamp ?? turn.created_at ?? turn.ts;
    if (ts && (!ctx.minTs || ts < ctx.minTs)) ctx.minTs = ts;
    if (ts && (!ctx.maxTs || ts > ctx.maxTs)) ctx.maxTs = ts;

    const inTok  = usage.prompt_tokens ?? usage.input_tokens ?? usage.input ?? 0;
    const outTok = usage.completion_tokens ?? usage.output_tokens ?? usage.output ?? 0;
    const crTok  = usage.cached_tokens ?? usage.cache_read_input_tokens ?? usage.cached ?? 0;
    if (ts) ctx.events.push({
      ts, inputTokens: inTok, outputTokens: outTok,
      cacheReadTokens: crTok, cacheCreationTokens: 0,
      provider: "vibe", model,
    });

    const addInto = (t: ModelTotals) => {
      // Mistral API shape: prompt_tokens / completion_tokens. Claude and
      // Gemini shapes fall through as fallbacks so a Vibe build that
      // ever emits those doesn't silently zero the cost.
      t.inputTokens     += inTok;
      t.outputTokens    += outTok;
      t.cacheReadTokens += crTok;
      // No cache-write tier documented for Devstral.
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
// OpenAI Codex CLI session scanner. Exact on-disk format is [UNVERIFIED] at
// the time of writing — Codex was not installed on the authoring machine.
// See docs/studies/STUDY-codex-tokens.md for the research that shaped this
// adapter. The scanner probes both full-file JSON (with a
// messages / output / items array) AND line-by-line JSONL, under
// `sessions/`, `history/`, or any subdir of the Codex root. Token fields
// follow the OpenAI Responses API shape (`usage.input_tokens` /
// `usage.output_tokens` / `usage.input_tokens_details.cached_tokens`).
// `$CODEX_HOME` overrides the default ~/.codex root.
// ───────────────────────────────────────────────────────────────────────────

/** Walk Codex root, return every `.json` / `.jsonl` file under the common
 *  session subdirs (`sessions/`, `history/`) or anywhere under the root
 *  if those aren't present. Recursive with MAX_SCAN_DEPTH cap. Returns []
 *  when the root is missing so the caller skips Codex silently. */
export function findCodexSessions(root: string): string[] {
  const files: string[] = [];
  if (!existsSync(root)) return files;

  // Prefer dedicated subdirs if they exist; fall back to scanning the whole
  // root so a non-standard layout still works.
  const candidates = [join(root, "sessions"), join(root, "history")].filter(existsSync);
  const starts = candidates.length > 0 ? candidates : [root];

  const seen = new Set<string>();
  const stack: Array<[string, number]> = starts.map(s => [s, 0]);
  while (stack.length > 0) {
    const [dir, depth] = stack.pop()!;
    if (seen.has(dir)) continue;
    seen.add(dir);
    if (depth > MAX_SCAN_DEPTH) continue;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      // When scanning the root as a fallback, skip the obvious non-session
      // noise so we don't pull in config / auth / log dotdirs.
      if (dir === root && (name === "config.toml" || name === "auth.json" || name === "log")) continue;
      const p = join(dir, name);
      let sub;
      try { sub = statSync(p); } catch { continue; }
      if (sub.isDirectory()) stack.push([p, depth + 1]);
      else if (sub.isFile() && (name.endsWith(".json") || name.endsWith(".jsonl"))) files.push(p);
    }
  }
  return files;
}

/** Codex wire id → PRICING key. `codex-priority` is selected only when the
 *  model string explicitly advertises priority (Codex exposes priority as a
 *  tier selector rather than a separate model family in most public docs).
 *  Everything else matching `codex` or `gpt-5` lands on `codex-standard`.
 *  Unknown strings fall back to `codex-standard` with `matched: false`. */
export function normalizeCodexModel(m: string | undefined): { key: string; matched: boolean } {
  if (!m) return { key: "codex-standard", matched: false };
  const low = m.toLowerCase();
  if (low.includes("priority")) return { key: "codex-priority", matched: true };
  if (low.includes("codex")) return { key: "codex-standard", matched: true };
  if (low.startsWith("gpt-5")) return { key: "codex-standard", matched: true };
  return { key: "codex-standard", matched: false };
}

/** Parse one Codex session file and fold assistant turns into the shared
 *  ScanContext. Accepts a full-JSON object (`{messages|output|items: [...]}`
 *  or a top-level array) and falls back to JSONL on parse failure.
 *
 *  Token mapping — OpenAI Responses API shape:
 *    usage.input_tokens  = TOTAL input (includes cached tokens)
 *    usage.input_tokens_details.cached_tokens = cached subset
 *    usage.output_tokens = total output
 *
 *  We subtract cached from total input so the downstream cost math doesn't
 *  double-count — `inputTokens` ends up as the fresh, non-cached input. */
export function scanCodexSession(filePath: string, ctx: ScanContext): void {
  if (fileTooLarge(filePath)) return;
  let content: string;
  try { content = readFileSync(filePath, "utf-8"); }
  catch { return; }

  let turns: any[] = [];
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) turns = parsed;
    else if (Array.isArray(parsed?.messages)) turns = parsed.messages;
    else if (Array.isArray(parsed?.output)) turns = parsed.output;
    else if (Array.isArray(parsed?.items)) turns = parsed.items;
    else if (Array.isArray(parsed?.history)) turns = parsed.history;
    else turns = [parsed];
  } catch {
    for (const raw of content.split("\n")) {
      if (!raw) continue;
      try { turns.push(JSON.parse(raw)); } catch { ctx.parseErrors++; }
    }
    if (turns.length === 0) return;
  }

  for (const turn of turns) {
    // Count every entry in the transcript; assistantLines counts only the
    // turns we price downstream.
    ctx.totalLines++;
    const isAssistant =
      turn?.role === "assistant" ||
      turn?.type === "assistant" ||
      turn?.type === "message" ||      // Responses API: type:"message", role:"assistant"
      turn?.type === "response";        // top-level response event
    if (!isAssistant && turn?.role !== "assistant") continue;
    ctx.assistantLines++;

    // Usage may sit on the turn, on a nested `response`, or on a `message`.
    const usage =
      turn.usage ??
      turn.response?.usage ??
      turn.message?.usage ??
      null;
    if (!usage) continue;
    ctx.withUsage++;

    const rawModel = turn.model ?? turn.response?.model ?? turn.message?.model;
    const { key: model, matched } = normalizeCodexModel(rawModel);
    if (!matched && typeof rawModel === "string" && rawModel) ctx.unknownCodexModels.add(rawModel);

    const ts: string | undefined =
      turn.timestamp ??
      turn.created_at ??
      (typeof turn.created === "number" ? new Date(turn.created * 1000).toISOString() : undefined);
    if (ts && (!ctx.minTs || ts < ctx.minTs)) ctx.minTs = ts;
    if (ts && (!ctx.maxTs || ts > ctx.maxTs)) ctx.maxTs = ts;

    const totalInput = usage.input_tokens ?? usage.prompt_tokens ?? 0;
    const cached = usage.input_tokens_details?.cached_tokens ?? usage.cached_tokens ?? 0;
    const inTok  = Math.max(0, totalInput - cached);
    const outTok = usage.output_tokens ?? usage.completion_tokens ?? 0;
    if (ts) ctx.events.push({
      ts, inputTokens: inTok, outputTokens: outTok,
      cacheReadTokens: cached, cacheCreationTokens: 0,
      provider: "codex", model,
    });

    const addInto = (t: ModelTotals) => {
      t.inputTokens     += inTok;
      t.cacheReadTokens += cached;
      t.outputTokens    += outTok;
      // Codex has no cache-write tier (cacheWrite:0 in config.json codex-*).
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
// OpenCode CLI session scanner. OpenCode is BYOK — each session can route
// to Anthropic, Google, OpenAI, or Mistral — so the scanner dispatches per
// turn rather than assuming a single provider. See
// docs/studies/STUDY-opencode-tokens.md for the on-disk layout.
//
// On-disk layout (confirmed against the upstream source,
// packages/opencode/src/session/message.ts in github.com/sst/opencode):
//
//   $OPENCODE_HOME/storage/session/
//     info/<sessionID>.json             ← session metadata (no role field)
//     message/<sessionID>/<messageID>.json  ← ONE message per file
//     part/<sessionID>/<messageID>/<partID>.json  ← parts (no tokens)
//
// Each message file is a SINGLE top-level object with:
//   { id, role: "assistant"|"user", sessionID, modelID, providerID,
//     time: { created: <ms-since-epoch> },
//     tokens: { input, output, reasoning, cache: { read, write } }, cost }
//
// The scanner deliberately walks ONLY the `message/` subtree — pulling in
// `info/` or `part/` files bloats totalLines with 0 matches and trips JSON
// parse failures on binary-ish part content.
// ───────────────────────────────────────────────────────────────────────────

/** Walk OpenCode root for per-message JSON transcripts. Prefers
 *  `storage/session/message/**` (the only subtree with role+tokens); falls
 *  back to `storage/session/**` then the whole root so a non-standard
 *  layout still works. Returns [] if the root is missing so the caller
 *  can skip OpenCode silently. */
export function findOpenCodeSessions(root: string): string[] {
  const files: string[] = [];
  if (!existsSync(root)) return files;

  // Prefer the narrowest path that actually exists. `message/` is the only
  // subtree carrying per-turn token counts; `info/` and `part/` live as
  // siblings and have no usage data, so including them just inflates
  // totalLines / parseErrors without finding anything to price.
  const messageDir = join(root, "storage", "session", "message");
  const sessionDir = join(root, "storage", "session");
  let starts: string[];
  if (existsSync(messageDir))      starts = [messageDir];
  else if (existsSync(sessionDir)) starts = [sessionDir];
  else                             starts = [root];

  const seen = new Set<string>();
  const stack: Array<[string, number]> = starts.map(s => [s, 0]);
  while (stack.length > 0) {
    const [dir, depth] = stack.pop()!;
    if (seen.has(dir)) continue;
    seen.add(dir);
    if (depth > MAX_SCAN_DEPTH) continue;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      // Root-level noise to skip when falling back to a full-root walk:
      //   opencode.db — SQLite index, binary garbage for our parser
      //   log/        — rotating log files, no usage data
      if (dir === root && (name === "opencode.db" || name === "log")) continue;
      const p = join(dir, name);
      let sub;
      try { sub = statSync(p); } catch { continue; }
      if (sub.isDirectory()) stack.push([p, depth + 1]);
      else if (sub.isFile() && name.endsWith(".json")) files.push(p);
    }
  }
  return files;
}

/** Dispatch an OpenCode turn's `(model, provider)` tuple to one of the
 *  existing provider-family normalizers. Returns the downstream pricing key
 *  and a `provider` tag the scanner uses to pick the correct usage-extraction
 *  shape. An explicit provider hint (from `turn.provider` / `turn.providerID`)
 *  wins; otherwise we sniff the model string. Returns `provider: "unknown"`
 *  with `matched: false` when nothing matches so the caller can warn once. */
export function normalizeOpenCodeModel(
  model: string | undefined,
  provider?: string | undefined,
): { key: string; matched: boolean; provider: "anthropic" | "google" | "openai" | "mistral" | "unknown" } {
  const p = (provider ?? "").toLowerCase();
  const m = (model ?? "").toLowerCase();

  // 1. Explicit provider hint — trust it over any model-string heuristic.
  if (p && (p.includes("anthropic") || p === "claude")) {
    const r = normalizeModel(model);
    return { key: r.key, matched: r.matched, provider: "anthropic" };
  }
  if (p && (p.includes("google") || p.includes("gemini") || p === "vertex")) {
    const r = normalizeGeminiModel(model);
    return { key: r.key, matched: r.matched, provider: "google" };
  }
  if (p && (p.includes("mistral") || p.includes("vibe") || p.includes("devstral"))) {
    const r = normalizeVibeModel(model);
    return { key: r.key, matched: r.matched, provider: "mistral" };
  }
  if (p && (p.includes("openai") || p.includes("codex"))) {
    const r = normalizeCodexModel(model);
    return { key: r.key, matched: r.matched, provider: "openai" };
  }

  // 2. Sniff from the model string. Order matters — "haiku" etc. check first
  //    so e.g. "claude-haiku-4-5" doesn't get caught by a later branch.
  if (m.includes("claude") || m.includes("haiku") || m.includes("sonnet") || m.includes("opus")) {
    const r = normalizeModel(model);
    return { key: r.key, matched: r.matched, provider: "anthropic" };
  }
  if (m.includes("gemini")) {
    const r = normalizeGeminiModel(model);
    return { key: r.key, matched: r.matched, provider: "google" };
  }
  if (m.includes("devstral") || m.includes("mistral")) {
    const r = normalizeVibeModel(model);
    return { key: r.key, matched: r.matched, provider: "mistral" };
  }
  if (m.includes("codex") || m.startsWith("gpt-5") || m.startsWith("gpt")) {
    const r = normalizeCodexModel(model);
    return { key: r.key, matched: r.matched, provider: "openai" };
  }

  // Unknown — bucket under claude-opus-4 so rendering has a stable key; the
  // caller tracks the raw string in ctx.unknownOpenCodeModels and warns.
  return { key: "claude-opus-4", matched: false, provider: "unknown" };
}

/** Parse one OpenCode message file and fold its assistant turn into the
 *  shared ScanContext.
 *
 *  OpenCode writes ONE message per file — the top-level object is the
 *  `MessageV2.Info` record, with `role`, `modelID`, `providerID`,
 *  `time.created` (ms since epoch), and a normalised `tokens` block:
 *
 *    tokens: { input, output, reasoning, cache: { read, write } }
 *
 *  That single normalised shape is OpenCode's contract, so we read it
 *  directly — no per-upstream-provider dispatch needed for tokens. The
 *  provider tag is still used to pick the pricing bucket via
 *  `normalizeOpenCodeModel` (anthropic→claude-*, openai→codex-*, etc.).
 *
 *  Legacy / wrapped / JSONL shapes are tolerated as fallbacks:
 *    - `{ info: {...} }` wrapping (older sessions) — unwrap the info object
 *    - top-level `parts/messages/turns/history` array — iterate as turns
 *    - `turn.usage` in upstream-provider shape — dispatch by provider */
export function scanOpenCodeSession(filePath: string, ctx: ScanContext): void {
  if (fileTooLarge(filePath)) return;
  let content: string;
  try { content = readFileSync(filePath, "utf-8"); }
  catch { return; }

  let turns: any[] = [];
  try {
    let parsed = JSON.parse(content);
    // OpenCode's primary shape: the file IS the message. Any top-level
    // object with a `role` string is treated as a single turn — never
    // descend into sibling arrays like `parts` (which are content
    // elements, not assistant turns).
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)
        && typeof parsed.role === "string") {
      turns = [parsed];
    } else if (parsed?.info && typeof parsed.info === "object"
               && typeof parsed.info.role === "string") {
      // Some wrappers use { info: { role, tokens, ... }, parts: [...] }.
      turns = [parsed.info];
    } else if (Array.isArray(parsed)) turns = parsed;
    else if (Array.isArray(parsed?.messages)) turns = parsed.messages;
    else if (Array.isArray(parsed?.turns)) turns = parsed.turns;
    else if (Array.isArray(parsed?.history)) turns = parsed.history;
    else turns = [parsed];
  } catch {
    for (const raw of content.split("\n")) {
      if (!raw) continue;
      try { turns.push(JSON.parse(raw)); } catch { ctx.parseErrors++; }
    }
    if (turns.length === 0) return;
  }

  for (const turn of turns) {
    ctx.totalLines++;
    const isAssistant =
      turn?.role === "assistant" ||
      turn?.type === "assistant" ||
      turn?.type === "message" ||      // some shapes carry type:"message" + role:"assistant"
      turn?.type === "response";
    if (!isAssistant && turn?.role !== "assistant") continue;
    ctx.assistantLines++;

    // OpenCode's normalised shape takes priority: a tokens object whose
    // children look like OpenCode's fields (plain integers or a `cache`
    // sub-object). Only fall through to upstream-provider usage blocks
    // when that shape isn't present.
    const ocTokens =
      turn.tokens && typeof turn.tokens === "object" && !Array.isArray(turn.tokens)
        && (typeof turn.tokens.input === "number"
            || typeof turn.tokens.output === "number"
            || (turn.tokens.cache && typeof turn.tokens.cache === "object"))
        ? turn.tokens : null;
    const usage = ocTokens ?? turn.usage ?? turn.message?.usage ?? turn.response?.usage ?? null;
    if (!usage) continue;
    ctx.withUsage++;

    // Model / provider can live at the turn level (OpenCode's
    // `modelID` / `providerID`), in a nested message/response, or under
    // a generic `model` / `provider` alias.
    const rawModel: string | undefined =
      turn.modelID ??
      turn.model ??
      turn.message?.model ??
      turn.response?.model;
    const rawProvider: string | undefined =
      turn.providerID ??
      turn.provider ??
      turn.message?.provider ??
      turn.response?.provider;
    const { key: model, matched, provider } = normalizeOpenCodeModel(rawModel, rawProvider);
    if (!matched && typeof rawModel === "string" && rawModel) ctx.unknownOpenCodeModels.add(rawModel);

    // OpenCode stamps `time.created` in MILLISECONDS (JS Date.now()).
    // Other shapes may carry `timestamp` / `created_at` ISO strings, or a
    // seconds-since-epoch `created` number (Responses API style).
    const ts: string | undefined =
      turn.timestamp ??
      turn.created_at ??
      (typeof turn.time?.created === "number" ? new Date(turn.time.created).toISOString() : undefined) ??
      (typeof turn.created === "number" ? new Date(turn.created * 1000).toISOString() : undefined);
    if (ts && (!ctx.minTs || ts < ctx.minTs)) ctx.minTs = ts;
    if (ts && (!ctx.maxTs || ts > ctx.maxTs)) ctx.maxTs = ts;

    // Resolve the token quad once so the event log and the totals stay
    // consistent. Branches mirror the previous per-provider logic.
    let inTok = 0, outTok = 0, crTok = 0, cwTok = 0;
    if (ocTokens) {
      const cache = (ocTokens.cache && typeof ocTokens.cache === "object") ? ocTokens.cache : {};
      inTok  = ocTokens.input ?? 0;
      outTok = (ocTokens.output ?? 0) + (ocTokens.reasoning ?? 0);
      crTok  = cache.read ?? 0;
      cwTok  = cache.write ?? 0;
    } else if (provider === "anthropic") {
      inTok  = usage.input_tokens ?? 0;
      outTok = usage.output_tokens ?? 0;
      crTok  = usage.cache_read_input_tokens ?? 0;
      cwTok  = usage.cache_creation_input_tokens ?? 0;
    } else if (provider === "openai") {
      const totalInput = usage.input_tokens ?? usage.prompt_tokens ?? 0;
      const cached = usage.input_tokens_details?.cached_tokens ?? usage.cached_tokens ?? 0;
      inTok  = Math.max(0, totalInput - cached);
      crTok  = cached;
      outTok = usage.output_tokens ?? usage.completion_tokens ?? 0;
    } else if (provider === "google") {
      inTok  = usage.input ?? usage.input_tokens ?? usage.prompt_tokens ?? 0;
      outTok = usage.output ?? usage.output_tokens ?? usage.completion_tokens ?? 0;
      crTok  = usage.cached ?? usage.cached_tokens ?? 0;
    } else if (provider === "mistral") {
      inTok  = usage.prompt_tokens ?? usage.input_tokens ?? usage.input ?? 0;
      outTok = usage.completion_tokens ?? usage.output_tokens ?? usage.output ?? 0;
      crTok  = usage.cached_tokens ?? usage.cache_read_input_tokens ?? usage.cached ?? 0;
    } else {
      // Unknown provider — permissive union so a new upstream doesn't
      // silently zero usage until we ship a mapping.
      inTok  = usage.input_tokens ?? usage.prompt_tokens ?? usage.input ?? 0;
      outTok = usage.output_tokens ?? usage.completion_tokens ?? usage.output ?? 0;
      crTok  = usage.cache_read_input_tokens ?? usage.cached_tokens ?? usage.cached ?? 0;
      cwTok  = usage.cache_creation_input_tokens ?? 0;
    }

    if (ts) ctx.events.push({
      ts, inputTokens: inTok, outputTokens: outTok,
      cacheReadTokens: crTok, cacheCreationTokens: cwTok,
      provider: "opencode", model,
    });

    const addInto = (t: ModelTotals) => {
      t.inputTokens        += inTok;
      t.outputTokens       += outTok;
      t.cacheReadTokens    += crTok;
      t.cacheCreationTokens += cwTok;
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
  // Suffixes are SI powers of ten (k=10³, M=10⁶, B=10⁹) — NOT bytes.
  // Token totals can exceed 10¹⁰ on cache-heavy Claude Code workloads
  // so the B threshold is load-bearing, not decorative.
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Render a filesystem path relative to the current working directory
 *  when practical, falling back to the raw path when the relative form
 *  would escape cwd (starts with "..") or when the input is already
 *  non-absolute. Paths that are sentinels like "embedded defaults" (not
 *  filesystem paths) pass through unchanged — callers guard for that
 *  upstream. */
export function fmtPathForDisplay(p: string): string {
  if (!isAbsolute(p)) return p;
  const rel = relative(process.cwd(), p);
  // Empty string = p IS cwd; leading ".." = escaped cwd, keep absolute.
  if (rel === "") return "./";
  if (rel.startsWith("..")) return p;
  return rel.startsWith(".") ? rel : `./${rel}`;
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

  const header = ["Model", "Msgs", "In", "Out", "CacheR", "CacheW", "Provider $", "Codex-Std $", "Codex-Pri $", "Ratio"];
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

type PlanStatusKind = "comfortable" | "marginal" | "exceeds" | "session-blocked" | "monthly-blocked";

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

function classifyPlans(
  stats: SubscriptionStats,
  planLimits: Record<string, PlanLimits>,
  monthlyBlockedKeys?: ReadonlySet<string>,
): PlanStatus[] {
  const out: PlanStatus[] = [];
  for (const [key, plan] of Object.entries(planLimits)) {
    const verdict = verdict5h(stats.avgPer5h, plan.messagesPer5h);
    let status: PlanStatusKind;
    let marginalPct: number | null = null;
    if (plan.sessionsCap != null && stats.avgSessionsPerMonth > plan.sessionsCap) {
      status = "session-blocked";
    } else if (monthlyBlockedKeys?.has(key)) {
      // Monthly-quota failures override the 5h verdict: a plan whose
      // 5h picture is "unlimited" may still fail on monthly caps
      // (e.g. Copilot tiers, which have no 5h throttling but tight
      // monthly premium-request budgets).
      status = "monthly-blocked";
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
 *  trade-off instead of a silently-tight recommendation.
 *
 *  `monthlyBlockedKeys` — optional. Plan keys whose monthly-quota
 *  simulation verdict is worse than "workable" (i.e. painful or
 *  unusable). These plans are disqualified from the "comfortable"
 *  bucket even when their 5h picture looks fine. Letting the
 *  recommender suggest Copilot Free at $0 just because Copilot has no
 *  5h cap was the behaviour this parameter closes. */
function findBestFit(
  stats: SubscriptionStats,
  planLimits: Record<string, PlanLimits>,
  monthlyBlockedKeys?: ReadonlySet<string>,
): BestFitRecommendation {
  const classified = classifyPlans(stats, planLimits, monthlyBlockedKeys);
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

// ───────────────────────────────────────────────────────────────────────────
// 5h window downgrade simulation
//
// Models Claude's rate-limit window directly: reset-on-expiry. A window
// opens on the first message, closes exactly 5h later; the *next* window
// opens on the first message AFTER that close. Messages during the closed
// interval don't count toward any window (the user was idle — no pressure
// on the limit).
//
// This is the shape that matches "how many times would I have been
// throttled?" — tumbling midnight-anchored buckets would split a single
// real burst across two buckets and inflate the hit count.
// ───────────────────────────────────────────────────────────────────────────

const WINDOW_MS = 5 * 60 * 60 * 1000;

export interface WindowBucket {
  /** ISO timestamp of the first event in the window (window open). */
  startTs: string;
  /** ISO timestamp of 5h after startTs (window close). */
  endTs: string;
  /** Raw number of ScanEvent records folded into this window. Claude
   *  Code writes one JSONL line per streamed content block, so this
   *  over-counts API calls by ~1.7× on tool-use-heavy workloads. Use
   *  messageCount for rate-limit comparisons. */
  eventCount: number;
  /** Distinct API-call count for this window. Events sharing a
   *  requestId collapse to one; events without a requestId (non-Claude
   *  providers) count 1 each. This is the quantity compared against
   *  plan `messagesPer5h` caps. */
  messageCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** input + output. Retained for diagnostic purposes — not used by
   *  the message-count-based plan simulation. */
  totalTokens: number;
}

/** Bucket events into reset-on-expiry 5h windows. Input does not need
 *  to be sorted — we sort a copy here so callers can pass raw
 *  ctx.events. Per-window `messageCount` dedups events by requestId so
 *  streamed content-block lines collapse to one API call; events with
 *  no requestId each count as one. */
export function compute5hWindows(events: ScanEvent[]): WindowBucket[] {
  if (events.length === 0) return [];
  const sorted = events.slice();
  sortEvents(sorted);

  const windows: WindowBucket[] = [];
  let cur: WindowBucket | null = null;
  let curStartMs = 0;
  let curSeenReqIds: Set<string> | null = null;

  for (const ev of sorted) {
    const t = new Date(ev.ts).getTime();
    if (isNaN(t)) continue;
    if (cur === null || t - curStartMs >= WINDOW_MS) {
      curStartMs = t;
      curSeenReqIds = new Set();
      cur = {
        startTs: ev.ts,
        endTs: new Date(t + WINDOW_MS).toISOString(),
        eventCount: 0,
        messageCount: 0,
        inputTokens: 0, outputTokens: 0,
        cacheReadTokens: 0, cacheCreationTokens: 0,
        totalTokens: 0,
      };
      windows.push(cur);
    }
    cur.eventCount++;
    if (ev.requestId) {
      if (!curSeenReqIds!.has(ev.requestId)) {
        curSeenReqIds!.add(ev.requestId);
        cur.messageCount++;
      }
    } else {
      cur.messageCount++;
    }
    cur.inputTokens        += ev.inputTokens;
    cur.outputTokens       += ev.outputTokens;
    cur.cacheReadTokens    += ev.cacheReadTokens;
    cur.cacheCreationTokens += ev.cacheCreationTokens;
    cur.totalTokens        += ev.inputTokens + ev.outputTokens;
  }

  return windows;
}

/** Verdict for a downgrade simulation hit-rate. Six-level scale so
 *  we can distinguish "you'd barely notice" (smooth) from "you'd grit
 *  your teeth" (frustrating) from "you'd rage-quit" (unusable).
 *
 *   ≤1%     → "smooth"       (effectively never throttled)
 *   1-5%    → "comfortable"  (occasional hiccup)
 *   5-15%   → "workable"     (tolerable, still functional)
 *   15-35%  → "painful"      (frequent throttling during active work)
 *   35-60%  → "frustrating"  (majority of active bursts near the line)
 *   >60%    → "unusable"     (most active windows hit the cap)
 */
export type HitRateKind = "smooth" | "comfortable" | "workable" | "painful" | "frustrating" | "unusable";

export function hitRateBadge(hitPct: number): { kind: HitRateKind; badge: string } {
  if (hitPct <= 1)  return { kind: "smooth",       badge: "smooth"       };
  if (hitPct <= 5)  return { kind: "comfortable",  badge: "comfortable"  };
  if (hitPct <= 15) return { kind: "workable",     badge: "workable"     };
  if (hitPct <= 35) return { kind: "painful",      badge: "painful"      };
  if (hitPct <= 60) return { kind: "frustrating",  badge: "frustrating"  };
  return                   { kind: "unusable",     badge: "unusable"     };
}

/** Collapse a [lo, hi]-style messagesPer5h band into a single effective
 *  cap for the downgrade simulation. hi wins when published (Pro/Team);
 *  lo is used for open-ended "lo+" baselines (Max tiers). Null plans
 *  have no cap and are skipped upstream. */
export function effectiveMsgCap(range: [number, number | null] | null): number | null {
  if (range === null) return null;
  const [lo, hi] = range;
  return hi ?? lo;
}

/** Coarse provider family used to split the downgrade simulation into
 *  "same provider" (pure downgrade ladder) vs "cross provider" (requires
 *  workflow migration) views. "other" covers any plan whose key doesn't
 *  match one of the known prefixes. */
export type PlanFamily = "claude" | "openai" | "mistral" | "copilot" | "other";

/** Map a plan key (e.g. "claude-max-20x", "copilot-pro") to a family.
 *  Prefix-based so adding a new tier in the same family stays zero-config. */
export function planFamilyOf(key: string): PlanFamily {
  if (key.startsWith("claude-"))  return "claude";
  if (key.startsWith("openai-"))  return "openai";
  if (key.startsWith("mistral-")) return "mistral";
  if (key.startsWith("copilot-")) return "copilot";
  return "other";
}

/** Map a pricing-key (e.g. "claude-opus-4", "codex-standard", "devstral-2",
 *  "gemini-pro") to the PLAN family the user is most likely subscribed
 *  under. Gemini has no coding-subscription plan in config, so returns
 *  "other" to signal "no same-provider section". */
function usageFamilyFromPricingKey(pricingKey: string): PlanFamily {
  if (pricingKey.startsWith("claude-"))   return "claude";
  if (pricingKey.startsWith("codex-"))    return "openai";
  if (pricingKey.startsWith("devstral-")) return "mistral";
  return "other";
}

/** Detect the user's likely current plan family by counting priced
 *  assistant messages per pricing family and picking the top one.
 *  Returns "other" if the top family doesn't map to any subscription
 *  family (e.g. a pure-Gemini user). */
export function detectCurrentFamily(byModel: Map<string, ModelTotals>): PlanFamily {
  const tallies = new Map<PlanFamily, number>();
  for (const [k, t] of byModel) {
    const fam = usageFamilyFromPricingKey(k);
    tallies.set(fam, (tallies.get(fam) ?? 0) + t.messageCount);
  }
  let bestFam: PlanFamily = "other";
  let bestCount = -1;
  for (const [fam, count] of tallies) {
    if (count > bestCount) { bestFam = fam; bestCount = count; }
  }
  return bestFam;
}

export interface DowngradeRow {
  key: string;
  label: string;
  monthlyUsd: number | null;
  /** Plan's provider family (claude / openai / mistral / copilot). */
  family: PlanFamily;
  /** Effective 5h cap applied: hi for fixed bands, lo for "lo+"
   *  baselines. null = plan has no 5h throttle (truly unlimited). */
  msgsPer5h: number | null;
  totalWindows: number;
  hitCount: number;
  hitPct: number;
  verdict: { kind: HitRateKind; badge: string };
  /** Plans whose 5h = null AND monthlyMsgCap is set are metered
   *  monthly, not per-5h (Copilot). Callers should surface a
   *  "see monthly table" placeholder instead of a numeric verdict. */
  monthlyMetered: boolean;
}

export interface DowngradeSimulation {
  totalWindows: number;
  /** Average priced assistant messages per active window. 0 when no windows. */
  avgMsgsPerWindow: number;
  /** Max priced assistant messages seen in any single window. */
  peakMsgsPerWindow: number;
  rows: DowngradeRow[];
}

export function simulateDowngrade(
  windows: WindowBucket[],
  planLimits: Record<string, PlanLimits>,
): DowngradeSimulation {
  const rows: DowngradeRow[] = [];
  for (const [key, plan] of Object.entries(planLimits)) {
    const cap = effectiveMsgCap(plan.messagesPer5h);
    const family = planFamilyOf(key);
    const monthlyMetered = cap == null && plan.monthlyMsgCap != null;
    let hitCount = 0;
    if (cap != null && cap > 0) {
      for (const w of windows) {
        if (w.messageCount > cap) hitCount++;
      }
    }
    // Truly-unlimited plans (null cap, no monthly sub) report 0/N.
    // Monthly-metered plans (Copilot) also report 0 here but are
    // tagged so the renderer can show a cross-reference to the
    // monthly table instead of a misleading "smooth".
    const hitPct = windows.length === 0 ? 0 : (hitCount / windows.length) * 100;
    rows.push({
      key, label: plan.label, monthlyUsd: plan.monthlyUsd,
      family,
      msgsPer5h: cap,
      totalWindows: windows.length,
      hitCount, hitPct,
      verdict: hitRateBadge(hitPct),
      monthlyMetered,
    });
  }
  // Cheapest plans first — users read downgrade risk bottom-up.
  rows.sort((a, b) => (a.monthlyUsd ?? Infinity) - (b.monthlyUsd ?? Infinity));

  let totalMsgs = 0, peak = 0;
  for (const w of windows) {
    totalMsgs += w.messageCount;
    if (w.messageCount > peak) peak = w.messageCount;
  }
  const avgMsgsPerWindow = windows.length === 0 ? 0 : totalMsgs / windows.length;

  return {
    totalWindows: windows.length,
    avgMsgsPerWindow, peakMsgsPerWindow: peak,
    rows,
  };
}

function priceStr(usd: number | null): string {
  return usd === null ? "custom pricing" : `$${usd}/mo`;
}

// ───────────────────────────────────────────────────────────────────────────
// Monthly quota simulation
//
// Same event stream the 5h sim uses, grouped by YYYY-MM instead of 5h
// rolling windows. Answers "on a plan with a monthly message cap (e.g.
// GitHub Copilot), how many calendar months would I have blown past
// the ceiling?"
//
// Like compute5hWindows, messageCount dedups events by requestId so a
// single API call's streamed content blocks don't over-count.
// ───────────────────────────────────────────────────────────────────────────

export interface MonthBucket {
  /** Calendar month (YYYY-MM). */
  yearMonth: string;
  /** Raw count of ScanEvent records in this month. */
  eventCount: number;
  /** Distinct-requestId message count for this month. Events without
   *  a requestId count as 1 each (same rule as 5h windows). */
  messageCount: number;
}

/** Group events into calendar-month buckets. Stable output order
 *  (ascending YYYY-MM). */
export function groupEventsByMonth(events: ScanEvent[]): MonthBucket[] {
  const byMonth = new Map<string, { eventCount: number; seen: Set<string>; missingIds: number }>();
  for (const ev of events) {
    const ym = yearMonth(ev.ts);
    if (!ym) continue;
    let m = byMonth.get(ym);
    if (!m) { m = { eventCount: 0, seen: new Set(), missingIds: 0 }; byMonth.set(ym, m); }
    m.eventCount++;
    if (ev.requestId) m.seen.add(ev.requestId);
    else m.missingIds++;
  }
  const out: MonthBucket[] = [];
  for (const [ym, m] of byMonth) {
    out.push({ yearMonth: ym, eventCount: m.eventCount, messageCount: m.seen.size + m.missingIds });
  }
  out.sort((a, b) => a.yearMonth.localeCompare(b.yearMonth));
  return out;
}

export interface MonthlyRow {
  key: string;
  label: string;
  monthlyUsd: number | null;
  /** Published monthly message cap for this plan. */
  monthlyCap: number;
  /** Unit label for the cap ("msgs" default, "premium req" for Copilot). */
  monthlyCapUnit: string;
  totalMonths: number;
  hitCount: number;
  hitPct: number;
  verdict: { kind: HitRateKind; badge: string };
  /** Short plan note, pass-through from config. */
  note?: string;
}

export interface MonthlySimulation {
  totalMonths: number;
  firstMonth: string | null;
  lastMonth: string | null;
  avgMsgsPerMonth: number;
  peakMsgsPerMonth: number;
  rows: MonthlyRow[];
}

export function simulateMonthlyQuota(
  months: MonthBucket[],
  planLimits: Record<string, PlanLimits>,
): MonthlySimulation {
  const rows: MonthlyRow[] = [];
  for (const [key, plan] of Object.entries(planLimits)) {
    const cap = plan.monthlyMsgCap;
    if (cap == null || cap <= 0) continue;
    let hitCount = 0;
    for (const m of months) {
      if (m.messageCount > cap) hitCount++;
    }
    const hitPct = months.length === 0 ? 0 : (hitCount / months.length) * 100;
    rows.push({
      key, label: plan.label, monthlyUsd: plan.monthlyUsd,
      monthlyCap: cap,
      monthlyCapUnit: plan.monthlyCapUnit ?? "msgs",
      totalMonths: months.length,
      hitCount, hitPct,
      verdict: hitRateBadge(hitPct),
      note: plan.note,
    });
  }
  rows.sort((a, b) => (a.monthlyUsd ?? Infinity) - (b.monthlyUsd ?? Infinity));

  let totalMsgs = 0, peak = 0;
  for (const m of months) {
    totalMsgs += m.messageCount;
    if (m.messageCount > peak) peak = m.messageCount;
  }
  const avgMsgsPerMonth = months.length === 0 ? 0 : totalMsgs / months.length;

  return {
    totalMonths: months.length,
    firstMonth: months.length ? months[0].yearMonth : null,
    lastMonth:  months.length ? months[months.length - 1].yearMonth : null,
    avgMsgsPerMonth, peakMsgsPerMonth: peak,
    rows,
  };
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

/** Pick the priced, non-Copilot plan with the lowest hit rate from a
 *  candidate DowngradeRow set. Ties broken by lower price. Returns null
 *  when no candidate has a published price. Used for the simulation-
 *  driven "Best fit" line — lets us rank by real distribution (fit %)
 *  instead of the flat-average verdict, and automatically excludes
 *  "custom pricing" (Enterprise) plans that would print an
 *  unactionable recommendation. */
export function pickBestFromSim(rows: DowngradeRow[]): DowngradeRow | null {
  const eligible = rows.filter(r => r.monthlyUsd != null && !r.monthlyMetered);
  if (eligible.length === 0) return null;
  const sorted = eligible.slice().sort((a, b) => {
    if (a.hitPct !== b.hitPct) return a.hitPct - b.hitPct;
    return (a.monthlyUsd ?? 0) - (b.monthlyUsd ?? 0);
  });
  return sorted[0];
}

/** The "budget option": the *next-cheapest* priced plan strictly below
 *  `maxPrice`. We pick the closest rung down (highest price under the
 *  ceiling) rather than the absolute cheapest, so the reader sees what
 *  a single-tier downgrade actually costs — not what going to the
 *  floor would. */
export function pickBudgetFromSim(rows: DowngradeRow[], excludeKey: string, maxPrice: number): DowngradeRow | null {
  const eligible = rows.filter(r =>
    r.monthlyUsd != null && !r.monthlyMetered
      && r.key !== excludeKey
      && (r.monthlyUsd ?? Infinity) < maxPrice
  );
  if (eligible.length === 0) return null;
  // Highest price under the ceiling = one rung down.
  const sorted = eligible.slice().sort((a, b) => (b.monthlyUsd ?? 0) - (a.monthlyUsd ?? 0));
  return sorted[0];
}

function fitPctString(row: DowngradeRow): string {
  const fit = Math.max(0, Math.min(100, 100 - row.hitPct));
  return `${fit.toFixed(0)}%`;
}

function renderSubscriptionSection(
  stats: SubscriptionStats,
  planLimits: Record<string, PlanLimits>,
  monthlyBlockedKeys: ReadonlySet<string> | undefined,
  currentFamily: PlanFamily,
  downgradeSim: DowngradeSimulation,
): string {
  if (stats.totalMessages === 0) return "No messages — subscription comparison skipped.\n";

  const out: string[] = [];
  out.push(`Your usage: ${stats.totalMessages.toLocaleString()} assistant messages over ${stats.daysSpanned.toFixed(1)} days`);
  out.push(`  ≈ ${stats.avgPerDay.toFixed(1)} msgs/day  ≈ ${stats.avgPer5h.toFixed(1)} msgs per 5h window`);
  out.push("");

  // Plans that have no 5h cap AND a monthly cap (Copilot family) are
  // filtered out of this table — showing them as "unlimited — fits"
  // is misleading when they're actually monthly-metered. They appear
  // in the dedicated monthly simulation section instead.
  const displayedPlans = Object.entries(planLimits)
    .filter(([, p]) => !(p.messagesPer5h == null && p.monthlyMsgCap != null));

  const header = ["Plan", "Price/mo", "5h limit", "Fits your avg?", "Note"];
  const body: string[][] = [];
  for (const [, plan] of displayedPlans) {
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

  // Best-fit block — driven by the 5h simulation (fit % = 100 - hitPct)
  // so we recommend based on real distribution, not the flat-average
  // verdict. Custom-priced plans (Enterprise) are excluded by
  // pickBestFromSim so we never print an unactionable
  // "Best fit: ... at custom pricing" line.
  const sameFamilyRows = downgradeSim.rows.filter(r => r.family === currentFamily);
  const bestSame = currentFamily !== "other" ? pickBestFromSim(sameFamilyRows) : null;
  const budgetSame = bestSame
    ? pickBudgetFromSim(sameFamilyRows, bestSame.key, bestSame.monthlyUsd ?? Infinity)
    : null;
  const bestAny = pickBestFromSim(downgradeSim.rows);
  // Reference the legacy findBestFit just to keep the variable alive for
  // the unused-import guard; machine consumers still read bestFitPayload
  // built from it in main().
  void monthlyBlockedKeys;

  const bestLines: string[] = [];
  if (bestSame) {
    bestLines.push(
      `→ Best fit (${familyLabel(currentFamily)}, published pricing): ${bestSame.label} at ${priceStr(bestSame.monthlyUsd)} — fits ${fitPctString(bestSame)} of your 5h windows`,
    );
    if (budgetSame) {
      bestLines.push(
        `→ Budget option (if you accept throttling): ${budgetSame.label} at ${priceStr(budgetSame.monthlyUsd)} — ${fitPctString(budgetSame)} of windows fit`,
      );
    }
  }
  if (bestAny && (!bestSame || bestAny.key !== bestSame.key)) {
    bestLines.push(
      `→ Best fit (any provider, requires migration): ${bestAny.label} at ${priceStr(bestAny.monthlyUsd)} — fits ${fitPctString(bestAny)} of your 5h windows`,
    );
  }
  if (bestLines.length === 0) {
    bestLines.push("→ No priced plan covers this workload — consider Enterprise or reducing usage");
  }

  const parts: string[] = [];
  parts.push(out.join("\n"));
  parts.push(renderTable(header, body).join("\n"));
  parts.push("");
  parts.push(sessionsLine);
  if (sessionsWarn) parts.push(sessionsWarn);
  parts.push("");
  parts.push(bestLines.join("\n"));
  return parts.join("\n") + "\n";
}

/** Pretty-print the plan family for section headers. */
function familyLabel(fam: PlanFamily): string {
  switch (fam) {
    case "claude":  return "Claude";
    case "openai":  return "OpenAI";
    case "mistral": return "Mistral";
    case "copilot": return "Copilot";
    case "other":   return "other";
  }
}

/** Pick the "anchor" plan: the priciest plan in the user's current
 *  family that actually has a 5h cap AND a published price. We
 *  interpret it as the user's likely current tier, then the downgrade
 *  ladder lists every cheaper same-family plan's simulation row. */
function findAnchorPlan(sim: DowngradeSimulation, family: PlanFamily): DowngradeRow | null {
  const candidates = sim.rows.filter(r => r.family === family && r.msgsPer5h != null && r.monthlyUsd != null);
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) => ((a.monthlyUsd ?? 0) >= (b.monthlyUsd ?? 0) ? a : b));
}

/** Render the two-part 5h simulation:
 *   1. Same-provider downgrade ladder (e.g. Claude Max 20x → Max 5x → Team → Pro).
 *   2. Cross-provider comparison — other families framed as migration options.
 *  Returns "" when there are no active windows. */
function renderSplitDowngradeSection(
  sim: DowngradeSimulation,
  daysSpanned: number,
  currentFamily: PlanFamily,
): string {
  if (sim.totalWindows === 0 || sim.rows.length === 0) return "";

  const out: string[] = [];
  out.push(`${sim.totalWindows.toLocaleString()} active 5h windows analyzed over ${daysSpanned.toFixed(0)} days`);
  out.push(`Avg messages per window: ${Math.round(sim.avgMsgsPerWindow).toLocaleString()} / Peak: ${sim.peakMsgsPerWindow.toLocaleString()}`);
  out.push("");

  // ── Same-provider downgrade ladder ────────────────────────────────
  const anchor = findAnchorPlan(sim, currentFamily);
  if (anchor) {
    out.push(`── 5h-window simulation: same-provider downgrade (${familyLabel(currentFamily)}) ──`);
    out.push(`Starting from ${anchor.label} at ${priceStr(anchor.monthlyUsd)}. Simulating downgrade to cheaper ${familyLabel(currentFamily)} tiers:`);
    const sameFamilyCheaper = sim.rows
      .filter(r => r.family === currentFamily
                && r.key !== anchor.key
                && (r.monthlyUsd ?? Infinity) < (anchor.monthlyUsd ?? 0))
      .sort((a, b) => (b.monthlyUsd ?? 0) - (a.monthlyUsd ?? 0)); // priciest-first as we step down
    if (sameFamilyCheaper.length === 0) {
      out.push(`  (no cheaper ${familyLabel(currentFamily)} tier is currently configured)`);
    } else {
      const header = ["Plan", "Price/mo", "Msg cap (5h)", "Windows over cap", "Hit %", "Verdict"];
      const body: string[][] = [];
      for (const r of sameFamilyCheaper) {
        body.push([
          r.label,
          priceStr(r.monthlyUsd),
          r.msgsPer5h == null ? "unlimited" : r.msgsPer5h.toLocaleString(),
          `${r.hitCount.toLocaleString()} / ${r.totalWindows.toLocaleString()}`,
          `${r.hitPct.toFixed(1)}%`,
          r.verdict.badge,
        ]);
      }
      out.push(renderTable(header, body).join("\n"));
    }
    out.push("");
  }

  // ── Cross-provider comparison ─────────────────────────────────────
  out.push("── 5h-window simulation: cross-provider comparison ──");
  out.push("If you migrated your usage pattern to another provider (requires migration):");
  out.push("Sorted by price descending; for best value (price vs hit rate), see Best fit above.");
  const crossRows = sim.rows.filter(r => r.family !== currentFamily);
  if (crossRows.length === 0) {
    out.push("  (no other providers configured)");
  } else {
    // Priced plans first, descending by price so the biggest bill
    // lands at the top. Custom/Enterprise priceless plans trail.
    const priced = crossRows.filter(r => r.monthlyUsd != null)
      .sort((a, b) => (b.monthlyUsd ?? 0) - (a.monthlyUsd ?? 0));
    const unpriced = crossRows.filter(r => r.monthlyUsd == null);
    const ordered = [...priced, ...unpriced];

    const header = ["Plan", "Windows over cap", "Hit %", "Verdict", "Price/mo"];
    const body: string[][] = [];
    for (const r of ordered) {
      let verdictCell: string;
      let hitPctCell: string;
      let overCapCell: string;
      if (r.monthlyMetered) {
        verdictCell = "N/A (monthly quota, see below)";
        hitPctCell = "—";
        overCapCell = "—";
      } else if (r.msgsPer5h == null) {
        verdictCell = `${r.verdict.badge} (unlimited)`;
        hitPctCell = `${r.hitPct.toFixed(1)}%`;
        overCapCell = `${r.hitCount.toLocaleString()} / ${r.totalWindows.toLocaleString()}`;
      } else {
        verdictCell = r.verdict.badge;
        hitPctCell = `${r.hitPct.toFixed(1)}%`;
        overCapCell = `${r.hitCount.toLocaleString()} / ${r.totalWindows.toLocaleString()}`;
      }
      body.push([r.label, overCapCell, hitPctCell, verdictCell, priceStr(r.monthlyUsd)]);
    }
    out.push(renderTable(header, body).join("\n"));

    // ── Same-price cross-family clashes ─────────────────────────────
    // Where a same-family plan and a cross-family plan sit at the
    // same price point AND both verdicts land at painful or worse,
    // emit a note: migration cost, not dollars, is the remaining
    // differentiator.
    const sameFamilyPriced = sim.rows.filter(r =>
      r.family === currentFamily && r.monthlyUsd != null && !r.monthlyMetered && r.msgsPer5h != null,
    );
    const badKinds = new Set<HitRateKind>(["painful", "frustrating", "unusable"]);
    const seenPrices = new Set<number>();
    const clashLines: string[] = [];
    for (const cross of priced) {
      if (cross.monthlyUsd == null || cross.monthlyMetered) continue;
      if (seenPrices.has(cross.monthlyUsd)) continue;
      const same = sameFamilyPriced.find(s => s.monthlyUsd === cross.monthlyUsd);
      if (!same) continue;
      if (!badKinds.has(cross.verdict.kind) || !badKinds.has(same.verdict.kind)) continue;
      seenPrices.add(cross.monthlyUsd);
      const verdictLabel = cross.verdict.kind === same.verdict.kind
        ? `'${cross.verdict.kind}'`
        : `'${same.verdict.kind}'/'${cross.verdict.kind}'`;
      clashLines.push(
        `Note: At ${priceStr(cross.monthlyUsd)}, both ${same.label} and ${cross.label} are ${verdictLabel} on your usage.`,
      );
    }
    if (clashLines.length > 0) {
      out.push("");
      for (const l of clashLines) out.push(l);
      out.push("The real difference is migration cost, not pricing.");
    }

    // ── Mistral "unlimited" disclaimer ──────────────────────────────
    // Trigger whenever a truly-unlimited Mistral row appears (no 5h
    // cap AND not monthly-metered). Mistral publishes "unlimited" but
    // there's no SLA or fair-use cap documented as of April 2026.
    const hasMistralUnlimited = crossRows.some(r =>
      r.family === "mistral" && r.msgsPer5h == null && !r.monthlyMetered,
    );
    if (hasMistralUnlimited) {
      out.push("");
      out.push("⚠ Mistral Pro/Team \"unlimited\" is Mistral's published claim; no public SLA");
      out.push("  or fair-use cap documented as of April 2026. Verify on sustained heavy");
      out.push("  usage before committing.");
    }
  }

  return out.join("\n") + "\n";
}

/** Render the monthly-quota simulation table. Empty string when there
 *  are no months or no plans with monthly caps. Appends cross-plan
 *  unit-mismatch disclaimers whenever a non-default unit (e.g.
 *  "premium req") appears, because Copilot premium requests are not
 *  1:1 comparable to Claude assistant messages. */
function renderMonthlySimSection(sim: MonthlySimulation): string {
  if (sim.totalMonths === 0 || sim.rows.length === 0) return "";

  const out: string[] = [];
  const span = sim.firstMonth && sim.lastMonth
    ? (sim.firstMonth === sim.lastMonth ? sim.firstMonth : `${sim.firstMonth} to ${sim.lastMonth}`)
    : "";
  out.push(`${sim.totalMonths.toLocaleString()} month(s) analyzed${span ? ` (${span})` : ""}`);
  out.push(`Avg messages per month: ${Math.round(sim.avgMsgsPerMonth).toLocaleString()} / Peak: ${sim.peakMsgsPerMonth.toLocaleString()}`);
  out.push("");

  const header = ["Plan", "Price/mo", "Monthly cap", "Months over cap", "Hit %", "Verdict"];
  const body: string[][] = [];
  for (const r of sim.rows) {
    body.push([
      r.label,
      r.monthlyUsd === null ? "custom" : `$${r.monthlyUsd}`,
      `${r.monthlyCap.toLocaleString()} ${r.monthlyCapUnit}`,
      `${r.hitCount.toLocaleString()} / ${r.totalMonths.toLocaleString()}`,
      `${r.hitPct.toFixed(1)}%`,
      r.verdict.badge,
    ]);
  }
  out.push(renderTable(header, body).join("\n"));

  const hasNonMsgUnits = sim.rows.some(r => r.monthlyCapUnit !== "msgs");
  if (hasNonMsgUnits) {
    out.push("");
    out.push("⚠ Copilot \"premium requests\" ≠ Claude \"messages\". A Copilot premium request");
    out.push("  can cost 1x–20x depending on the model used (e.g. Claude Opus via Copilot");
    out.push("  costs more than GPT-4.1). Direct comparison with Claude message counts is");
    out.push("  approximate — no official conversion factor exists.");
    out.push("⚠ Copilot's 2,000 completions/month (Free tier) are inline autocomplete,");
    out.push("  not chat/agent requests. Only premium requests are comparable to Claude turns.");
  }
  return out.join("\n") + "\n";
}

function renderScanSummary(providers: ProviderStats[], ctx: ScanContext, configSource: string): string {
  const active = providers.filter(p => p.files > 0 || p.messages > 0);
  const out: string[] = ["── Scan summary ──"];
  if (active.length === 0) {
    out.push("No session files found.");
    out.push(`Config: ${configSource === "fallback" ? "embedded defaults" : fmtPathForDisplay(configSource)}`);
    return out.join("\n") + "\n";
  }

  const header = ["Provider", "Files", "Entries", "Messages", "With tokens", "Parse-errors", "Date range"];
  const body: string[][] = [];
  let totFiles = 0, totEntries = 0, totMessages = 0, totWithTokens = 0, totParseErrors = 0;

  for (const p of active) {
    const range = p.minTs && p.maxTs ? `${p.minTs.slice(0, 10)} → ${p.maxTs.slice(0, 10)}` : "—";
    body.push([
      p.name,
      p.files.toLocaleString(),
      p.entries.toLocaleString(),
      p.messages.toLocaleString(),
      p.withTokens.toLocaleString(),
      String(p.parseErrors),
      range,
    ]);
    totFiles       += p.files;
    totEntries     += p.entries;
    totMessages    += p.messages;
    totWithTokens  += p.withTokens;
    totParseErrors += p.parseErrors;
  }
  if (active.length > 1) {
    body.push([
      "TOTAL",
      totFiles.toLocaleString(),
      totEntries.toLocaleString(),
      totMessages.toLocaleString(),
      totWithTokens.toLocaleString(),
      String(totParseErrors),
      "",
    ]);
  }

  out.push(renderTable(header, body).join("\n"));

  // Token totals across all providers — a one-liner below the table so the
  // reader sees the full scale of the scan at a glance without scrolling
  // through per-model rows.
  let input = 0, output = 0, cacheRead = 0, cacheWrite = 0;
  for (const t of ctx.byModel.values()) {
    input     += t.inputTokens;
    output    += t.outputTokens;
    cacheRead += t.cacheReadTokens;
    cacheWrite += t.cacheCreationTokens;
  }
  out.push(
    `Tokens: ${fmtTokens(input)} input, ${fmtTokens(output)} output, ` +
    `${fmtTokens(cacheRead)} cache-read, ${fmtTokens(cacheWrite)} cache-write ` +
    `(all providers combined)`,
  );
  // Cache-read totals dwarf everything else on tool-heavy Claude Code
  // usage — make it explicit that this is a cost signal, not a
  // rate-limit signal, so readers don't conflate the two.
  if (cacheRead > 0) {
    out.push(`  (cache-read and cache-write affect cost only; they don't count toward 5h message limits)`);
  }
  out.push(`Config: ${configSource === "fallback" ? "embedded defaults" : fmtPathForDisplay(configSource)}`);
  return out.join("\n") + "\n";
}

function renderMonthlySection(byMonth: Map<string, Map<string, ModelTotals>>, pricing: Record<string, ModelPricing>): string {
  if (byMonth.size === 0) return "No timestamped messages for monthly breakdown.\n";

  const header = ["Month", "Msgs", "In", "Out", "CacheR", "CacheW", "Provider $", "Codex-Std $", "Ratio"];
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
  /** Per-provider scan snapshots. Inactive providers are filtered out of the
   *  header; a Gemini-only run never mentions Claude and vice-versa. */
  providerStats: ProviderStats[];
  minTs: string | null;
  maxTs: string | null;
  /** Plan keys disqualified by the monthly-quota simulation. Passed
   *  through to findBestFit so the markdown recommendation agrees with
   *  the terminal/JSON one. Optional — callers pre-dating the monthly
   *  sim can omit it. */
  monthlyBlockedKeys?: ReadonlySet<string>;
}

export function renderMarkdown(inp: MarkdownInput): string {
  const today = new Date().toISOString().slice(0, 10);
  const firstDate = inp.minTs ? inp.minTs.slice(0, 10) : "n/a";
  const lastDate = inp.maxTs ? inp.maxTs.slice(0, 10) : "n/a";
  const out: string[] = [];

  out.push("## subfit-ai Report — find the plan that fits your usage");
  out.push("");
  out.push(`**Date:** ${today}  `);
  const activeProviders = inp.providerStats.filter(p => p.files > 0 || p.messages > 0);
  if (activeProviders.length === 0) {
    out.push(`**Scanned:** no session files found`);
  } else {
    out.push(`**Scanned:**  `);
    for (const p of activeProviders) {
      const filesStr = p.files.toLocaleString();
      const msgsStr = p.messages.toLocaleString();
      out.push(`- **${p.name}**: ${filesStr} file(s), ${msgsStr} assistant message(s)`);
    }
  }
  out.push(`**Session date range:** ${firstDate} → ${lastDate}`);
  out.push("");

  // Monthly table
  out.push("### Monthly breakdown");
  out.push("");
  const codexStd = inp.pricing["codex-standard"];
  if (inp.byMonth.size === 0 || !codexStd) {
    out.push("_No timestamped messages available._");
  } else {
    out.push(gfmRow(["Month", "Tokens In", "Tokens Out", "Provider $", "Codex $"]));
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
    out.push(gfmRow(["Model", "Msgs", "Input", "Output", "Cache R", "Cache W", "Provider $", "Codex Std $", "Codex Pri $", "Ratio"]));
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
    const best = findBestFit(inp.subStats, inp.planLimits, inp.monthlyBlockedKeys);
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
  if (args.version) { process.stdout.write(`subfit-ai ${readVersion()}\n`); return 0; }

  // M3 — warn once per run about unrecognized tokens, then continue.
  if (args.unknownFlags.length > 0) {
    process.stderr.write(`subfit-ai: unknown arg(s) ignored: ${args.unknownFlags.join(" ")}\n`);
    process.stderr.write(`  (run with --help to see supported options)\n`);
  }

  // --demo overrides all scan roots with bundled fixtures. The Gemini /
  // Vibe / Codex / OpenCode overrides point at directories that may or may
  // not exist — if they don't, the corresponding scan is skipped silently,
  // so --demo never bleeds into real ~/.gemini, ~/.vibe, ~/.codex, or
  // ~/.local/share/opencode data.
  if (args.demo) {
    args.path = join(scriptDir(), "examples");
    args.geminiPath = join(scriptDir(), "examples-gemini");
    args.vibePath = join(scriptDir(), "examples-vibe");
    args.codexPath = join(scriptDir(), "examples-codex");
    args.opencodePath = join(scriptDir(), "examples-opencode");
  }

  // Abort only when NONE of the provider roots exist — each provider is
  // opt-in, so a machine with only one of them installed should still work.
  const claudeExists   = existsSync(args.path);
  const geminiExists   = existsSync(args.geminiPath);
  const vibeExists     = existsSync(args.vibePath);
  const codexExists    = existsSync(args.codexPath);
  const opencodeExists = existsSync(args.opencodePath);
  if (!claudeExists && !geminiExists && !vibeExists && !codexExists && !opencodeExists) {
    process.stderr.write(`subfit-ai: no provider path exists\n`);
    process.stderr.write(`  --path           ${args.path}\n`);
    process.stderr.write(`  --gemini-path    ${args.geminiPath}\n`);
    process.stderr.write(`  --vibe-path      ${args.vibePath}\n`);
    process.stderr.write(`  --codex-path     ${args.codexPath}\n`);
    process.stderr.write(`  --opencode-path  ${args.opencodePath}\n`);
    process.stderr.write(`  (use --path / --gemini-path / --vibe-path / --codex-path / --opencode-path to point somewhere else, or --help)\n`);
    return 1;
  }

  const { config, source: configSource } = loadConfig(args.config ?? undefined);
  const { pricing, planLimits } = config;

  const files         = claudeExists   ? findJsonlFiles(args.path)             : [];
  const geminiFiles   = geminiExists   ? findGeminiSessions(args.geminiPath)   : [];
  const vibeFiles     = vibeExists     ? findVibeSessions(args.vibePath)       : [];
  const codexFiles    = codexExists    ? findCodexSessions(args.codexPath)     : [];
  const opencodeFiles = opencodeExists ? findOpenCodeSessions(args.opencodePath) : [];

  const ctxClaude   = emptyScanContext();
  const ctxGemini   = emptyScanContext();
  const ctxVibe     = emptyScanContext();
  const ctxCodex    = emptyScanContext();
  const ctxOpenCode = emptyScanContext();

  // Progress logs → stderr only so --json output on stdout stays clean.
  // On a TTY we use CR + `\x1b[K` (clear-to-end-of-line) so each update
  // overwrites the previous one, collapsing the N progress lines into a
  // single live row that the final summary table then takes over from.
  // When stderr is piped / redirected (CI logs, file captures), we fall
  // back to the old stacked newline-terminated format so nothing is lost.
  const stderrIsTTY = process.stderr.isTTY === true;
  const progress = (msg: string) => {
    if (stderrIsTTY) process.stderr.write(`\r\x1b[K${msg}`);
    else process.stderr.write(msg + "\n");
  };
  const progressClear = () => {
    if (stderrIsTTY) process.stderr.write(`\r\x1b[K`);
  };

  if (claudeExists) {
    progress(`⏳ Scanning Claude sessions under ${args.path} ...`);
    for (const f of files) scanJsonl(f, ctxClaude);
    progress(
      `✓ Claude: ${files.length.toLocaleString()} file(s) scanned ` +
      `(${ctxClaude.totalLines.toLocaleString()} lines, ` +
      `${ctxClaude.assistantLines.toLocaleString()} assistant messages)`,
    );
  }
  if (geminiExists) {
    progress(`⏳ Scanning Gemini sessions under ${args.geminiPath} ...`);
    for (const f of geminiFiles) scanGeminiSession(f, ctxGemini);
    progress(
      `✓ Gemini: ${geminiFiles.length.toLocaleString()} session(s) scanned ` +
      `(${ctxGemini.assistantLines.toLocaleString()} assistant messages)`,
    );
  }
  if (vibeExists) {
    progress(`⏳ Scanning Vibe sessions under ${args.vibePath} ...`);
    for (const f of vibeFiles) scanVibeSession(f, ctxVibe);
    progress(
      `✓ Vibe: ${vibeFiles.length.toLocaleString()} session(s) scanned ` +
      `(${ctxVibe.assistantLines.toLocaleString()} assistant messages)`,
    );
  }
  if (codexExists) {
    progress(`⏳ Scanning Codex sessions under ${args.codexPath} ...`);
    for (const f of codexFiles) scanCodexSession(f, ctxCodex);
    progress(
      `✓ Codex: ${codexFiles.length.toLocaleString()} session(s) scanned ` +
      `(${ctxCodex.assistantLines.toLocaleString()} assistant messages)`,
    );
  }
  if (opencodeExists) {
    progress(`⏳ Scanning OpenCode sessions under ${args.opencodePath} ...`);
    for (const f of opencodeFiles) scanOpenCodeSession(f, ctxOpenCode);
    progress(
      `✓ OpenCode: ${opencodeFiles.length.toLocaleString()} session(s) scanned ` +
      `(${ctxOpenCode.assistantLines.toLocaleString()} assistant messages)`,
    );
  }
  progress(`⏳ Computing costs ...`);
  const ctx = mergeContexts(
    mergeContexts(
      mergeContexts(mergeContexts(ctxClaude, ctxGemini), ctxVibe),
      ctxCodex,
    ),
    ctxOpenCode,
  );
  progress(`✓ Done.`);
  // Leave stderr on a clean line so stdout (summary table) starts fresh.
  progressClear();

  const providerStats: ProviderStats[] = [
    providerStatsOf("Claude",   files.length,         ctxClaude),
    providerStatsOf("Gemini",   geminiFiles.length,   ctxGemini),
    providerStatsOf("Vibe",     vibeFiles.length,     ctxVibe),
    providerStatsOf("Codex",    codexFiles.length,    ctxCodex),
    providerStatsOf("OpenCode", opencodeFiles.length, ctxOpenCode),
  ];

  // Unknown-model warnings are collected here and emitted at the END of
  // the run (after tables on stdout are flushed) so the output reads
  // cleanly: summary → subscription → per-model → per-month → warnings.
  // Raw wire names come from untrusted JSONL/JSON content and must be
  // sanitized before writing to a TTY to avoid escape-sequence injection.
  const emitUnknownModelWarnings = () => {
    if (ctx.unknownClaudeModels.size > 0) {
      const list = [...ctx.unknownClaudeModels].map(sanitizeForTerminal).sort().join(", ");
      process.stderr.write(`subfit-ai: unrecognized Claude model id(s) bucketed as Claude Opus: ${list}\n`);
      process.stderr.write(`  (update normalizeModel() or config.pricing to add a proper bucket)\n`);
    }
    if (ctx.unknownGeminiModels.size > 0) {
      const list = [...ctx.unknownGeminiModels].map(sanitizeForTerminal).sort().join(", ");
      process.stderr.write(`subfit-ai: unrecognized Gemini model id(s) bucketed as Gemini Pro: ${list}\n`);
      process.stderr.write(`  (update normalizeGeminiModel() or config.pricing to add a proper bucket)\n`);
    }
    if (ctx.unknownVibeModels.size > 0) {
      const list = [...ctx.unknownVibeModels].map(sanitizeForTerminal).sort().join(", ");
      process.stderr.write(`subfit-ai: unrecognized Vibe model id(s) bucketed as Devstral 2: ${list}\n`);
      process.stderr.write(`  (update normalizeVibeModel() or config.pricing to add a proper bucket)\n`);
    }
    if (ctx.unknownCodexModels.size > 0) {
      const list = [...ctx.unknownCodexModels].map(sanitizeForTerminal).sort().join(", ");
      process.stderr.write(`subfit-ai: unrecognized Codex model id(s) bucketed as codex-standard: ${list}\n`);
      process.stderr.write(`  (update normalizeCodexModel() or config.pricing to add a proper bucket)\n`);
    }
    if (ctx.unknownOpenCodeModels.size > 0) {
      const list = [...ctx.unknownOpenCodeModels].map(sanitizeForTerminal).sort().join(", ");
      process.stderr.write(`subfit-ai: unrecognized OpenCode model id(s) (provider could not be inferred): ${list}\n`);
      process.stderr.write(`  (update normalizeOpenCodeModel() to route this model to a provider family)\n`);
    }
  };

  const rows = computeRows(ctx.byModel, pricing);
  const subStats = computeSubscriptionStats(
    ctx.withUsage,        // 5h verdict is about messages that actually spent tokens;
    ctx.minTs,            // bare assistantLines over-counts tool-only / empty turns.
    ctx.maxTs,
    files.length + geminiFiles.length + vibeFiles.length + codexFiles.length + opencodeFiles.length,  // 1 file ≈ 1 session per provider
    ctx.byMonth.size,                   // distinct YYYY-MM buckets with data
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
  // Compute the 5h and monthly simulations BEFORE findBestFit — the
  // monthly verdict feeds into best-fit classification so a plan with
  // no 5h cap (Copilot) but a tight monthly cap cannot be recommended.
  const windows = compute5hWindows(ctx.events);
  const downgradeSim = simulateDowngrade(windows, planLimits);
  const monthBuckets = groupEventsByMonth(ctx.events);
  const monthlySim = simulateMonthlyQuota(monthBuckets, planLimits);
  const monthlyBlockedKeys = new Set(
    monthlySim.rows
      // Anything worse than "workable" (≤15% hit rate) on a monthly cap
      // disqualifies the plan from the best-fit comfortable pool.
      .filter(r => r.verdict.kind === "painful" || r.verdict.kind === "frustrating" || r.verdict.kind === "unusable")
      .map(r => r.key),
  );
  // User's likely current plan family — used to split the 5h simulation
  // into "same-provider downgrade ladder" vs "cross-provider migration"
  // views, and to scope the same-provider best-fit line.
  const currentFamily = detectCurrentFamily(ctx.byModel);

  const bestFit = findBestFit(subStats, planLimits, monthlyBlockedKeys);
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
      geminiPath: args.geminiPath,
      vibePath: args.vibePath,
      codexPath: args.codexPath,
      opencodePath: args.opencodePath,
      configSource,
      filesScanned: files.length,
      geminiSessionsScanned: geminiFiles.length,
      vibeSessionsScanned: vibeFiles.length,
      codexSessionsScanned: codexFiles.length,
      opencodeSessionsScanned: opencodeFiles.length,
      dateRange: { first: ctx.minTs, last: ctx.maxTs },
      stats: {
        totalLines: ctx.totalLines,
        assistantLines: ctx.assistantLines,
        withUsage: ctx.withUsage,
        parseErrors: ctx.parseErrors,
      },
      unknownClaudeModels:   [...ctx.unknownClaudeModels].sort(),
      unknownGeminiModels:   [...ctx.unknownGeminiModels].sort(),
      unknownVibeModels:     [...ctx.unknownVibeModels].sort(),
      unknownCodexModels:    [...ctx.unknownCodexModels].sort(),
      unknownOpenCodeModels: [...ctx.unknownOpenCodeModels].sort(),
      providerStats,
      pricing,
      planLimits,
      subscriptionStats: subStats,
      subscriptionVerdicts,
      bestFit: bestFitPayload,
      downgradeSimulation: downgradeSim,
      monthlyQuotaSimulation: monthlySim,
      byModel: rows,
      byMonth: Object.fromEntries(
        [...ctx.byMonth.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([ym, bucket]) => [
          ym,
          Object.fromEntries([...bucket.entries()]),
        ]),
      ),
    };
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    // Warnings fire after the JSON document — JSON consumers parse the
    // single object on stdout; humans inspecting both streams still get
    // the warning text on stderr at the end of the run.
    emitUnknownModelWarnings();
    // Allow --export alongside --json
    if (args.exportPath) {
      const target = args.exportPath;
      if (existsSync(target)) {
        if (!args.force) {
          process.stderr.write(`subfit-ai: ${target} exists, use --force to overwrite\n`);
          return 1;
        }
        process.stderr.write(`subfit-ai: overwriting existing file ${target}\n`);
      }
      try {
        const md = renderMarkdown({
          rows, byMonth: ctx.byMonth, subStats,
          pricing, planLimits,
          providerStats,
          minTs: ctx.minTs, maxTs: ctx.maxTs,
          monthlyBlockedKeys,
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

  const out: string[] = [];
  out.push(renderScanSummary(providerStats, ctx, configSource));
  // Lead with the subscription verdict (the question users actually came for);
  // the per-model / per-month tables follow as supporting evidence.
  out.push("── Subscription comparison ──");
  out.push(renderSubscriptionSection(subStats, planLimits, monthlyBlockedKeys, currentFamily, downgradeSim));
  const downgradeBlock = renderSplitDowngradeSection(downgradeSim, subStats.daysSpanned, currentFamily);
  if (downgradeBlock) {
    out.push(downgradeBlock);
  }
  const monthlyBlock = renderMonthlySimSection(monthlySim);
  if (monthlyBlock) {
    out.push("── Monthly premium-request simulation (GitHub Copilot only) ──");
    out.push(monthlyBlock);
  }
  out.push("── Per model ──");
  out.push(renderModelSection(rows));
  if (args.monthly) {
    out.push("── Per month ──");
    out.push(renderMonthlySection(ctx.byMonth, pricing));
  }
  out.push("Ratio column: Codex-Std cost divided by the Provider cost on the same tokens.");
  out.push("  <1.0  → Codex cheaper than the native provider on this volume");
  out.push("  >1.0  → Native provider cheaper than Codex on this volume");
  // Volatility warning lands after all tables so the output flow reads
  // summary → subscription → per-model → per-month → warnings.
  out.push("");
  out.push(VOLATILITY_WARNING);
  process.stdout.write(out.join("\n") + "\n");

  // Unknown-model warnings go last on stderr so they appear below the
  // (stdout-bound) tables in an interleaved terminal view.
  emitUnknownModelWarnings();

  // --export: write GFM markdown report alongside the terminal output
  if (args.exportPath) {
    const target = args.exportPath;
    if (existsSync(target)) {
      if (!args.force) {
        process.stderr.write(`subfit-ai: ${target} exists, use --force to overwrite\n`);
        return 1;
      }
      process.stderr.write(`subfit-ai: overwriting existing file ${target}\n`);
    }
    try {
      const md = renderMarkdown({
        rows, byMonth: ctx.byMonth, subStats,
        pricing, planLimits,
        providerStats,
        minTs: ctx.minTs, maxTs: ctx.maxTs,
        monthlyBlockedKeys,
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
// sortEvents and ScanEvent are exported at their definitions in this file.
export type { BestFitRecommendation, PlanStatus, ScanContext, ModelTotals };
