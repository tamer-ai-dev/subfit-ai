import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  normalizeGeminiModel,
  findGeminiSessions,
  scanGeminiSession,
  type ScanContext,
} from "../subfit-ai.ts";

describe("normalizeGeminiModel", () => {
  it("buckets Pro wire names (2.5 Pro, 3 Pro preview) to gemini-pro", () => {
    for (const w of ["gemini-2.5-pro", "gemini-3-pro-preview", "Gemini-Pro"]) {
      expect(normalizeGeminiModel(w)).toEqual({ key: "gemini-pro", matched: true });
    }
  });

  it("buckets Flash wire names (non-lite) to gemini-flash", () => {
    for (const w of ["gemini-2.5-flash", "gemini-3-flash-preview"]) {
      expect(normalizeGeminiModel(w)).toEqual({ key: "gemini-flash", matched: true });
    }
  });

  it("buckets Flash-Lite wire names to gemini-flash-lite (order matters: must match before 'flash')", () => {
    for (const w of ["gemini-2.5-flash-lite", "gemini-3-flash-lite-preview"]) {
      expect(normalizeGeminiModel(w)).toEqual({ key: "gemini-flash-lite", matched: true });
    }
  });

  it("flags unknown strings with matched:false and defaults to gemini-pro bucket", () => {
    expect(normalizeGeminiModel("palm-3")).toEqual({ key: "gemini-pro", matched: false });
    expect(normalizeGeminiModel(undefined)).toEqual({ key: "gemini-pro", matched: false });
    expect(normalizeGeminiModel("")).toEqual({ key: "gemini-pro", matched: false });
  });
});

describe("findGeminiSessions", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = join(tmpdir(), `subfit-gemini-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  });

  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("returns an empty list when the root does not exist", () => {
    expect(findGeminiSessions(join(tmpRoot, "does-not-exist"))).toEqual([]);
  });

  it("discovers session-*.json under tmp/<slug>/chats/ and skips other files", () => {
    mkdirSync(join(tmpRoot, "tmp/slug-a/chats"), { recursive: true });
    mkdirSync(join(tmpRoot, "tmp/slug-b/chats"), { recursive: true });
    writeFileSync(join(tmpRoot, "tmp/slug-a/chats/session-2026-04-23T08-00-abc.json"), "{}");
    writeFileSync(join(tmpRoot, "tmp/slug-a/chats/session-2026-04-23T09-00-def.json"), "{}");
    writeFileSync(join(tmpRoot, "tmp/slug-a/chats/not-a-session.json"), "{}");
    writeFileSync(join(tmpRoot, "tmp/slug-b/chats/session-2026-04-23T10-00-ghi.json"), "{}");
    writeFileSync(join(tmpRoot, "tmp/stray-file.json"), "{}"); // outside chats/

    const out = findGeminiSessions(tmpRoot).sort();
    expect(out).toHaveLength(3);
    expect(out.every(p => p.endsWith(".json") && p.includes("/chats/session-"))).toBe(true);
  });
});

describe("scanGeminiSession", () => {
  const freshCtx = (): ScanContext => ({
    byModel: new Map(),
    byMonth: new Map(),
    minTs: null, maxTs: null,
    totalLines: 0, assistantLines: 0, withUsage: 0, parseErrors: 0,
    unknownClaudeModels: new Set(),
    unknownGeminiModels: new Set(),
    unknownVibeModels: new Set(),
  });

  let tmpFile: string;
  beforeEach(() => {
    tmpFile = join(tmpdir(), `subfit-gemini-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  });
  afterEach(() => {
    try { rmSync(tmpFile, { force: true }); } catch { /* ignore */ }
  });

  it("folds `type === 'gemini'` turns with tokens into the shared context", () => {
    writeFileSync(tmpFile, JSON.stringify({
      messages: [
        { type: "user", content: "hi" },
        { type: "gemini", timestamp: "2026-04-23T08:00:00.000Z",
          tokens: { input: 1000, output: 200, cached: 500 },
          model: "gemini-2.5-pro" },
        { type: "gemini", timestamp: "2026-04-23T08:01:00.000Z",
          tokens: { input: 2000, output: 300, cached: 1200 },
          model: "gemini-3-flash-preview" },
      ],
    }));
    const ctx = freshCtx();
    scanGeminiSession(tmpFile, ctx);

    expect(ctx.assistantLines).toBe(2);
    expect(ctx.withUsage).toBe(2);
    expect(ctx.byModel.get("gemini-pro")?.inputTokens).toBe(1000);
    expect(ctx.byModel.get("gemini-pro")?.cacheReadTokens).toBe(500);
    expect(ctx.byModel.get("gemini-flash")?.inputTokens).toBe(2000);
    expect(ctx.byModel.get("gemini-flash")?.cacheCreationTokens).toBe(0); // Gemini has no cache-write
    expect(ctx.minTs).toBe("2026-04-23T08:00:00.000Z");
    expect(ctx.maxTs).toBe("2026-04-23T08:01:00.000Z");
  });

  it("skips user messages and gemini turns without tokens", () => {
    writeFileSync(tmpFile, JSON.stringify({
      messages: [
        { type: "user", content: "ping" },
        { type: "gemini", content: "no usage block" }, // no tokens
        { type: "gemini", content: "ok", tokens: { input: 100, output: 50, cached: 0 }, model: "gemini-2.5-flash" },
      ],
    }));
    const ctx = freshCtx();
    scanGeminiSession(tmpFile, ctx);

    expect(ctx.assistantLines).toBe(2); // both gemini messages counted
    expect(ctx.withUsage).toBe(1);      // only one had tokens
    expect([...ctx.byModel.keys()]).toEqual(["gemini-flash"]);
  });

  it("swallows malformed JSON and increments parseErrors", () => {
    writeFileSync(tmpFile, "{not valid json");
    const ctx = freshCtx();
    scanGeminiSession(tmpFile, ctx);

    expect(ctx.parseErrors).toBe(1);
    expect(ctx.assistantLines).toBe(0);
  });

  it("adds unrecognized model strings to unknownGeminiModels (not unknownClaudeModels)", () => {
    writeFileSync(tmpFile, JSON.stringify({
      messages: [
        { type: "gemini", tokens: { input: 1, output: 1, cached: 0 }, model: "palm-v5" },
      ],
    }));
    const ctx = freshCtx();
    scanGeminiSession(tmpFile, ctx);

    expect(ctx.unknownGeminiModels.has("palm-v5")).toBe(true);
    expect(ctx.unknownClaudeModels.has("palm-v5")).toBe(false);
  });
});
