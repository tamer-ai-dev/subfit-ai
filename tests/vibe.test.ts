import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  normalizeVibeModel,
  findVibeSessions,
  scanVibeSession,
  type ScanContext,
} from "../subfit-ai.ts";

describe("normalizeVibeModel", () => {
  it("buckets Devstral 2 variants to devstral-2", () => {
    for (const w of ["devstral-2", "devstral-2-123b", "Devstral-2"]) {
      expect(normalizeVibeModel(w)).toEqual({ key: "devstral-2", matched: true });
    }
  });

  it("buckets Devstral Small variants to devstral-small-2 (small must match before devstral)", () => {
    for (const w of ["devstral-small-2", "devstral-small-2-24b", "Devstral-Small-2"]) {
      expect(normalizeVibeModel(w)).toEqual({ key: "devstral-small-2", matched: true });
    }
  });

  it("flags unknown strings with matched:false and defaults to devstral-2", () => {
    expect(normalizeVibeModel("mistral-large")).toEqual({ key: "devstral-2", matched: false });
    expect(normalizeVibeModel(undefined)).toEqual({ key: "devstral-2", matched: false });
    expect(normalizeVibeModel("")).toEqual({ key: "devstral-2", matched: false });
  });
});

describe("findVibeSessions", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = join(tmpdir(), `subfit-vibe-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  });
  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("returns [] when root does not exist", () => {
    expect(findVibeSessions(join(tmpRoot, "does-not-exist"))).toEqual([]);
  });

  it("returns [] when root exists but logs/ does not", () => {
    mkdirSync(tmpRoot, { recursive: true });
    expect(findVibeSessions(tmpRoot)).toEqual([]);
  });

  it("discovers .json and .jsonl files under logs/ (recursive)", () => {
    mkdirSync(join(tmpRoot, "logs/2026-04"), { recursive: true });
    mkdirSync(join(tmpRoot, "logs/2026-05"), { recursive: true });
    writeFileSync(join(tmpRoot, "logs/session-a.json"), "{}");
    writeFileSync(join(tmpRoot, "logs/session-b.jsonl"), "{}");
    writeFileSync(join(tmpRoot, "logs/2026-04/nested.json"), "{}");
    writeFileSync(join(tmpRoot, "logs/2026-05/readme.md"), "# ignore"); // not .json/.jsonl

    const out = findVibeSessions(tmpRoot).sort();
    expect(out).toHaveLength(3);
    expect(out.every(p => p.endsWith(".json") || p.endsWith(".jsonl"))).toBe(true);
  });
});

describe("scanVibeSession", () => {
  const freshCtx = (): ScanContext => ({
    byModel: new Map(),
    byMonth: new Map(),
    minTs: null, maxTs: null,
    totalLines: 0, assistantLines: 0, withUsage: 0, parseErrors: 0,
    unknownClaudeModels: new Set(),
    unknownGeminiModels: new Set(),
    unknownVibeModels: new Set(),
    unknownCodexModels: new Set(),
    unknownOpenCodeModels: new Set(),
  });

  let tmpFile: string;
  beforeEach(() => {
    tmpFile = join(tmpdir(), `subfit-vibe-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  });
  afterEach(() => {
    try { rmSync(tmpFile, { force: true }); } catch { /* ignore */ }
  });

  it("parses a full-file JSON with a messages[] array", () => {
    writeFileSync(tmpFile, JSON.stringify({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", timestamp: "2026-04-23T10:00:00Z",
          model: "devstral-2",
          usage: { prompt_tokens: 1000, completion_tokens: 200 } },
        { role: "assistant", timestamp: "2026-04-23T10:01:00Z",
          model: "devstral-small-2",
          usage: { prompt_tokens: 500, completion_tokens: 100 } },
      ],
    }));
    const ctx = freshCtx();
    scanVibeSession(tmpFile, ctx);

    expect(ctx.assistantLines).toBe(2);
    expect(ctx.withUsage).toBe(2);
    expect(ctx.byModel.get("devstral-2")?.inputTokens).toBe(1000);
    expect(ctx.byModel.get("devstral-2")?.outputTokens).toBe(200);
    expect(ctx.byModel.get("devstral-small-2")?.inputTokens).toBe(500);
    expect(ctx.minTs).toBe("2026-04-23T10:00:00Z");
    expect(ctx.maxTs).toBe("2026-04-23T10:01:00Z");
  });

  it("falls back to JSONL when the file is not a single JSON object", () => {
    const lines = [
      JSON.stringify({ type: "user", content: "hi" }),
      JSON.stringify({ type: "assistant", timestamp: "2026-04-23T10:00:00Z",
        model: "devstral-2",
        usage: { prompt_tokens: 300, completion_tokens: 50 } }),
    ].join("\n");
    writeFileSync(tmpFile, lines);
    const ctx = freshCtx();
    scanVibeSession(tmpFile, ctx);

    expect(ctx.assistantLines).toBe(1);
    expect(ctx.byModel.get("devstral-2")?.inputTokens).toBe(300);
  });

  it("skips user messages and assistant turns without usage", () => {
    writeFileSync(tmpFile, JSON.stringify({
      messages: [
        { role: "user", content: "ping" },
        { role: "assistant", content: "no usage here" },
        { role: "assistant", model: "devstral-2",
          usage: { prompt_tokens: 10, completion_tokens: 5 } },
      ],
    }));
    const ctx = freshCtx();
    scanVibeSession(tmpFile, ctx);

    expect(ctx.assistantLines).toBe(2);
    expect(ctx.withUsage).toBe(1);
  });

  it("accepts `cached_tokens` (Mistral) and maps to cacheReadTokens", () => {
    writeFileSync(tmpFile, JSON.stringify({
      messages: [
        { role: "assistant", model: "devstral-2",
          usage: { prompt_tokens: 1000, completion_tokens: 100, cached_tokens: 800 } },
      ],
    }));
    const ctx = freshCtx();
    scanVibeSession(tmpFile, ctx);

    const t = ctx.byModel.get("devstral-2")!;
    expect(t.inputTokens).toBe(1000);
    expect(t.cacheReadTokens).toBe(800);
    expect(t.cacheCreationTokens).toBe(0);
  });

  it("adds unrecognized model strings to unknownVibeModels only (not Claude/Gemini)", () => {
    writeFileSync(tmpFile, JSON.stringify({
      messages: [
        { role: "assistant", model: "mistral-experimental-v0",
          usage: { prompt_tokens: 1, completion_tokens: 1 } },
      ],
    }));
    const ctx = freshCtx();
    scanVibeSession(tmpFile, ctx);

    expect(ctx.unknownVibeModels.has("mistral-experimental-v0")).toBe(true);
    expect(ctx.unknownClaudeModels.size).toBe(0);
    expect(ctx.unknownGeminiModels.size).toBe(0);
  });
});
