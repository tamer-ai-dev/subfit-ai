import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  normalizeOpenCodeModel,
  findOpenCodeSessions,
  scanOpenCodeSession,
  type ScanContext,
} from "../subfit-ai.ts";

describe("normalizeOpenCodeModel", () => {
  it("routes via an explicit provider hint regardless of model-string hints", () => {
    // provider="anthropic" wins even though "gpt-4" looks like OpenAI
    expect(normalizeOpenCodeModel("gpt-4", "anthropic")).toEqual({
      key: "claude-opus-4", matched: false, provider: "anthropic",
    });
    expect(normalizeOpenCodeModel("claude-opus-4-7", "anthropic")).toEqual({
      key: "claude-opus-4", matched: true, provider: "anthropic",
    });
    expect(normalizeOpenCodeModel("gemini-2.5-pro", "google")).toEqual({
      key: "gemini-pro", matched: true, provider: "google",
    });
    expect(normalizeOpenCodeModel("devstral-small-2", "mistral")).toEqual({
      key: "devstral-small-2", matched: true, provider: "mistral",
    });
    expect(normalizeOpenCodeModel("gpt-5.3-codex", "openai")).toEqual({
      key: "codex-standard", matched: true, provider: "openai",
    });
  });

  it("sniffs the provider from the model string when no hint is given", () => {
    expect(normalizeOpenCodeModel("claude-sonnet-4-6")).toEqual({
      key: "claude-sonnet-4", matched: true, provider: "anthropic",
    });
    expect(normalizeOpenCodeModel("gemini-3-pro-preview")).toEqual({
      key: "gemini-pro", matched: true, provider: "google",
    });
    expect(normalizeOpenCodeModel("devstral-2")).toEqual({
      key: "devstral-2", matched: true, provider: "mistral",
    });
    expect(normalizeOpenCodeModel("gpt-5.1-codex-mini")).toEqual({
      key: "codex-standard", matched: true, provider: "openai",
    });
  });

  it("returns provider:'unknown' with matched:false when nothing matches", () => {
    expect(normalizeOpenCodeModel("llama-3-70b")).toEqual({
      key: "claude-opus-4", matched: false, provider: "unknown",
    });
    expect(normalizeOpenCodeModel(undefined)).toEqual({
      key: "claude-opus-4", matched: false, provider: "unknown",
    });
    expect(normalizeOpenCodeModel("")).toEqual({
      key: "claude-opus-4", matched: false, provider: "unknown",
    });
  });
});

describe("findOpenCodeSessions", () => {
  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = join(tmpdir(), `subfit-opencode-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  });
  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("returns [] when the root does not exist", () => {
    expect(findOpenCodeSessions(join(tmpRoot, "does-not-exist"))).toEqual([]);
  });

  it("prefers storage/session/message/** and ignores sibling info/ & part/ subtrees", () => {
    // Real OpenCode layout: info/ holds session metadata (no tokens),
    // message/ holds per-message records (the only files we want), and
    // part/ holds content elements (no tokens). Walking all three
    // inflated totalLines / parseErrors in production.
    mkdirSync(join(tmpRoot, "storage/session/info"), { recursive: true });
    mkdirSync(join(tmpRoot, "storage/session/message/ses_abc"), { recursive: true });
    mkdirSync(join(tmpRoot, "storage/session/part/ses_abc/msg_1"), { recursive: true });
    writeFileSync(join(tmpRoot, "storage/session/info/ses_abc.json"), "{}");
    writeFileSync(join(tmpRoot, "storage/session/message/ses_abc/msg_1.json"), "{}");
    writeFileSync(join(tmpRoot, "storage/session/message/ses_abc/msg_2.json"), "{}");
    writeFileSync(join(tmpRoot, "storage/session/part/ses_abc/msg_1/part_1.json"), "{}");

    const out = findOpenCodeSessions(tmpRoot).sort();
    expect(out).toHaveLength(2);
    expect(out.every(p => p.includes("/storage/session/message/"))).toBe(true);
    expect(out.every(p => !p.includes("/info/") && !p.includes("/part/"))).toBe(true);
  });

  it("falls back to storage/session/** when the message/ subtree is absent", () => {
    mkdirSync(join(tmpRoot, "storage/session"), { recursive: true });
    writeFileSync(join(tmpRoot, "storage/session/loose.json"), "{}");
    const out = findOpenCodeSessions(tmpRoot);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/loose\.json$/);
  });

  it("falls back to a root scan and skips opencode.db / log when storage/session is absent", () => {
    mkdirSync(tmpRoot, { recursive: true });
    mkdirSync(join(tmpRoot, "log"), { recursive: true });
    writeFileSync(join(tmpRoot, "loose-session.json"), "{}");
    writeFileSync(join(tmpRoot, "opencode.db"), "SQLITE_BINARY");
    writeFileSync(join(tmpRoot, "log/rotate.json"), "{}");  // under skipped dir

    const out = findOpenCodeSessions(tmpRoot);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/loose-session\.json$/);
  });
});

describe("scanOpenCodeSession", () => {
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
    tmpFile = join(tmpdir(), `subfit-opencode-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  });
  afterEach(() => {
    try { rmSync(tmpFile, { force: true }); } catch { /* ignore */ }
  });

  it("extracts Anthropic usage shape when provider='anthropic'", () => {
    writeFileSync(tmpFile, JSON.stringify({
      messages: [
        { role: "assistant", timestamp: "2026-04-23T10:00:00Z",
          model: "claude-sonnet-4-6",
          provider: "anthropic",
          usage: {
            input_tokens: 1_000,
            output_tokens: 500,
            cache_read_input_tokens: 4_000,
            cache_creation_input_tokens: 200,
          } },
      ],
    }));
    const ctx = freshCtx();
    scanOpenCodeSession(tmpFile, ctx);

    const t = ctx.byModel.get("claude-sonnet-4")!;
    expect(t.inputTokens).toBe(1_000);
    expect(t.outputTokens).toBe(500);
    expect(t.cacheReadTokens).toBe(4_000);
    expect(t.cacheCreationTokens).toBe(200);
  });

  it("subtracts cached_tokens from input_tokens for OpenAI-provider turns", () => {
    writeFileSync(tmpFile, JSON.stringify({
      messages: [
        { role: "assistant", timestamp: "2026-04-23T11:00:00Z",
          model: "gpt-5.3-codex",
          providerID: "openai",
          usage: {
            input_tokens: 10_000,
            input_tokens_details: { cached_tokens: 7_000 },
            output_tokens: 500,
          } },
      ],
    }));
    const ctx = freshCtx();
    scanOpenCodeSession(tmpFile, ctx);

    const t = ctx.byModel.get("codex-standard")!;
    expect(t.inputTokens).toBe(3_000);     // 10k - 7k cached
    expect(t.cacheReadTokens).toBe(7_000);
    expect(t.outputTokens).toBe(500);
    expect(t.cacheCreationTokens).toBe(0); // Codex has no cache-write tier
  });

  it("routes Google / Mistral turns to the right pricing keys and usage shapes", () => {
    writeFileSync(tmpFile, JSON.stringify({
      messages: [
        { role: "assistant", timestamp: "2026-04-23T12:00:00Z",
          model: "gemini-2.5-pro", provider: "google",
          usage: { input: 100, output: 50, cached: 20 } },
        { role: "assistant", timestamp: "2026-04-23T12:05:00Z",
          model: "devstral-small-2", provider: "mistral",
          usage: { prompt_tokens: 200, completion_tokens: 80, cached_tokens: 30 } },
      ],
    }));
    const ctx = freshCtx();
    scanOpenCodeSession(tmpFile, ctx);

    const g = ctx.byModel.get("gemini-pro")!;
    expect(g.inputTokens).toBe(100);
    expect(g.outputTokens).toBe(50);
    expect(g.cacheReadTokens).toBe(20);

    const m = ctx.byModel.get("devstral-small-2")!;
    expect(m.inputTokens).toBe(200);
    expect(m.outputTokens).toBe(80);
    expect(m.cacheReadTokens).toBe(30);
  });

  it("falls back to JSONL parsing when the file is not a single JSON object", () => {
    const lines = [
      JSON.stringify({ type: "response", model: "claude-opus-4-7", provider: "anthropic",
        usage: { input_tokens: 100, output_tokens: 50 } }),
      JSON.stringify({ type: "user", content: "ignored" }),
    ].join("\n");
    writeFileSync(tmpFile, lines);
    const ctx = freshCtx();
    scanOpenCodeSession(tmpFile, ctx);

    expect(ctx.assistantLines).toBe(1);
    expect(ctx.byModel.get("claude-opus-4")?.inputTokens).toBe(100);
  });

  it("tracks unrecognized model strings in unknownOpenCodeModels only", () => {
    writeFileSync(tmpFile, JSON.stringify({
      messages: [
        { role: "assistant", model: "llama-3-70b",
          usage: { input_tokens: 1, output_tokens: 1 } },
      ],
    }));
    const ctx = freshCtx();
    scanOpenCodeSession(tmpFile, ctx);

    expect(ctx.unknownOpenCodeModels.has("llama-3-70b")).toBe(true);
    expect(ctx.unknownClaudeModels.size).toBe(0);
    expect(ctx.unknownGeminiModels.size).toBe(0);
    expect(ctx.unknownVibeModels.size).toBe(0);
    expect(ctx.unknownCodexModels.size).toBe(0);
  });

  it("parses the real OpenCode message shape (top-level object, normalized tokens)", () => {
    // This is the actual on-disk shape in ~/.local/share/opencode/storage/
    // session/message/<ses>/<msg>.json — one message per file, top-level
    // role/modelID/providerID, `time.created` in milliseconds, and a
    // normalized `tokens` object that OpenCode populates regardless of
    // which upstream provider was called.
    const createdMs = Date.UTC(2026, 3, 23, 10, 0, 0); // 2026-04-23T10:00:00Z
    writeFileSync(tmpFile, JSON.stringify({
      id: "msg_abc123",
      role: "assistant",
      sessionID: "ses_xyz",
      modelID: "claude-sonnet-4-6",
      providerID: "anthropic",
      time: { created: createdMs, completed: createdMs + 5000 },
      tokens: {
        input: 1_000,
        output: 500,
        reasoning: 0,
        cache: { read: 4_000, write: 200 },
      },
      cost: 0.0321,
    }));
    const ctx = freshCtx();
    scanOpenCodeSession(tmpFile, ctx);

    expect(ctx.assistantLines).toBe(1);
    expect(ctx.withUsage).toBe(1);
    const t = ctx.byModel.get("claude-sonnet-4")!;
    expect(t.inputTokens).toBe(1_000);
    expect(t.outputTokens).toBe(500);
    expect(t.cacheReadTokens).toBe(4_000);
    expect(t.cacheCreationTokens).toBe(200);
    expect(ctx.minTs).toBe("2026-04-23T10:00:00.000Z");
    // Unknown sets should NOT be touched for a well-formed turn.
    expect(ctx.unknownOpenCodeModels.size).toBe(0);
  });

  it("adds reasoning tokens to output (OpenAI bills reasoning at output rate)", () => {
    writeFileSync(tmpFile, JSON.stringify({
      role: "assistant",
      modelID: "gpt-5.3-codex",
      providerID: "openai",
      tokens: { input: 100, output: 50, reasoning: 30,
                cache: { read: 0, write: 0 } },
    }));
    const ctx = freshCtx();
    scanOpenCodeSession(tmpFile, ctx);

    const t = ctx.byModel.get("codex-standard")!;
    expect(t.outputTokens).toBe(80);   // 50 + 30 reasoning
    expect(t.inputTokens).toBe(100);
  });

  it("unwraps a legacy { info: {...} } wrapper", () => {
    writeFileSync(tmpFile, JSON.stringify({
      info: {
        role: "assistant",
        modelID: "claude-haiku-4-5",
        providerID: "anthropic",
        tokens: { input: 10, output: 5, cache: { read: 0, write: 0 } },
      },
      parts: [{ type: "text", text: "ignored" }],
    }));
    const ctx = freshCtx();
    scanOpenCodeSession(tmpFile, ctx);

    expect(ctx.withUsage).toBe(1);
    expect(ctx.byModel.get("claude-haiku-4-5")?.inputTokens).toBe(10);
  });

  it("skips user-role messages (no role:assistant → no token charge)", () => {
    writeFileSync(tmpFile, JSON.stringify({
      role: "user",
      sessionID: "ses_xyz",
      time: { created: Date.now() },
    }));
    const ctx = freshCtx();
    scanOpenCodeSession(tmpFile, ctx);

    expect(ctx.totalLines).toBe(1);
    expect(ctx.assistantLines).toBe(0);
    expect(ctx.withUsage).toBe(0);
    expect(ctx.byModel.size).toBe(0);
  });
});
