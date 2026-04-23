import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  normalizeCodexModel,
  findCodexSessions,
  scanCodexSession,
  type ScanContext,
} from "../subfit-ai.ts";

describe("normalizeCodexModel", () => {
  it("routes explicit priority strings to codex-priority", () => {
    for (const w of ["gpt-5.3-codex-priority", "codex-priority", "CODEX-PRIORITY"]) {
      expect(normalizeCodexModel(w)).toEqual({ key: "codex-priority", matched: true });
    }
  });

  it("routes codex/gpt-5 variants to codex-standard", () => {
    for (const w of ["gpt-5.3-codex", "gpt-5.1-codex", "gpt-5.1-codex-mini", "gpt-5"]) {
      expect(normalizeCodexModel(w)).toEqual({ key: "codex-standard", matched: true });
    }
  });

  it("flags unknown strings with matched:false and defaults to codex-standard", () => {
    expect(normalizeCodexModel("gpt-4o")).toEqual({ key: "codex-standard", matched: false });
    expect(normalizeCodexModel(undefined)).toEqual({ key: "codex-standard", matched: false });
    expect(normalizeCodexModel("")).toEqual({ key: "codex-standard", matched: false });
  });
});

describe("findCodexSessions", () => {
  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = join(tmpdir(), `subfit-codex-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  });
  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("returns [] when the root does not exist", () => {
    expect(findCodexSessions(join(tmpRoot, "does-not-exist"))).toEqual([]);
  });

  it("prefers sessions/ when present and ignores config.toml / auth.json at the root level", () => {
    mkdirSync(join(tmpRoot, "sessions"), { recursive: true });
    writeFileSync(join(tmpRoot, "sessions/session-a.jsonl"), "{}");
    writeFileSync(join(tmpRoot, "sessions/session-b.json"), "{}");
    writeFileSync(join(tmpRoot, "config.toml"), "");          // must not be picked up
    writeFileSync(join(tmpRoot, "auth.json"), "{}");           // must not be picked up

    const out = findCodexSessions(tmpRoot).sort();
    expect(out).toHaveLength(2);
    expect(out.every(p => p.includes("/sessions/"))).toBe(true);
  });

  it("falls back to root scan when neither sessions/ nor history/ exists", () => {
    mkdirSync(tmpRoot, { recursive: true });
    writeFileSync(join(tmpRoot, "loose-session.jsonl"), "{}");
    writeFileSync(join(tmpRoot, "config.toml"), "");           // skipped by the root-fallback filter

    const out = findCodexSessions(tmpRoot);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/loose-session\.jsonl$/);
  });

  it("merges sessions/ and history/ when both are present", () => {
    mkdirSync(join(tmpRoot, "sessions"), { recursive: true });
    mkdirSync(join(tmpRoot, "history"), { recursive: true });
    writeFileSync(join(tmpRoot, "sessions/a.jsonl"), "{}");
    writeFileSync(join(tmpRoot, "history/b.json"), "{}");
    expect(findCodexSessions(tmpRoot)).toHaveLength(2);
  });
});

describe("scanCodexSession", () => {
  const freshCtx = (): ScanContext => ({
    byModel: new Map(),
    byMonth: new Map(),
    minTs: null, maxTs: null,
    totalLines: 0, assistantLines: 0, withUsage: 0, parseErrors: 0,
    unknownClaudeModels: new Set(),
    unknownGeminiModels: new Set(),
    unknownVibeModels: new Set(),
    unknownCodexModels: new Set(),
  });

  let tmpFile: string;
  beforeEach(() => {
    tmpFile = join(tmpdir(), `subfit-codex-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  });
  afterEach(() => {
    try { rmSync(tmpFile, { force: true }); } catch { /* ignore */ }
  });

  it("subtracts cached_tokens from input_tokens so the cached portion is not double-counted", () => {
    writeFileSync(tmpFile, JSON.stringify({
      messages: [
        { role: "assistant", timestamp: "2026-04-23T10:00:00Z",
          model: "gpt-5.3-codex",
          usage: {
            input_tokens: 10_000,
            input_tokens_details: { cached_tokens: 7_000 },
            output_tokens: 500,
          } },
      ],
    }));
    const ctx = freshCtx();
    scanCodexSession(tmpFile, ctx);

    const t = ctx.byModel.get("codex-standard")!;
    expect(t.inputTokens).toBe(3_000);      // 10k total - 7k cached
    expect(t.cacheReadTokens).toBe(7_000);
    expect(t.outputTokens).toBe(500);
    expect(t.cacheCreationTokens).toBe(0);
  });

  it("accepts JSONL fallback when the file is not a single JSON object", () => {
    const lines = [
      JSON.stringify({ type: "response", model: "gpt-5.3-codex",
        usage: { input_tokens: 100, output_tokens: 50 } }),
      JSON.stringify({ type: "user", content: "ignored" }),
    ].join("\n");
    writeFileSync(tmpFile, lines);
    const ctx = freshCtx();
    scanCodexSession(tmpFile, ctx);

    expect(ctx.assistantLines).toBe(1);
    expect(ctx.byModel.get("codex-standard")?.inputTokens).toBe(100);
  });

  it("honors `type: 'message'` + `role: 'assistant'` shape (Responses API)", () => {
    writeFileSync(tmpFile, JSON.stringify({
      output: [
        { type: "message", role: "assistant",
          model: "gpt-5.1-codex",
          usage: { input_tokens: 200, output_tokens: 80 } },
      ],
    }));
    const ctx = freshCtx();
    scanCodexSession(tmpFile, ctx);

    expect(ctx.withUsage).toBe(1);
    expect(ctx.byModel.get("codex-standard")?.outputTokens).toBe(80);
  });

  it("derives timestamps from `created` (seconds) when no ISO timestamp is present", () => {
    const createdSec = Math.floor(Date.UTC(2026, 3, 23, 9, 20, 0) / 1000); // 2026-04-23T09:20:00Z
    writeFileSync(tmpFile, JSON.stringify({
      messages: [
        { role: "assistant",
          created: createdSec,
          model: "gpt-5.3-codex",
          usage: { input_tokens: 10, output_tokens: 5 } },
      ],
    }));
    const ctx = freshCtx();
    scanCodexSession(tmpFile, ctx);

    expect(ctx.minTs).toBe("2026-04-23T09:20:00.000Z");
  });

  it("adds unrecognized model strings to unknownCodexModels only", () => {
    writeFileSync(tmpFile, JSON.stringify({
      messages: [
        { role: "assistant", model: "gpt-4o",
          usage: { input_tokens: 1, output_tokens: 1 } },
      ],
    }));
    const ctx = freshCtx();
    scanCodexSession(tmpFile, ctx);

    expect(ctx.unknownCodexModels.has("gpt-4o")).toBe(true);
    expect(ctx.unknownClaudeModels.size).toBe(0);
    expect(ctx.unknownGeminiModels.size).toBe(0);
    expect(ctx.unknownVibeModels.size).toBe(0);
  });
});
