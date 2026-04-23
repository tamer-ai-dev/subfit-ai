# Study: OpenAI Codex CLI Token Storage & Subfit-ai Adapter

This document analyzes how **OpenAI Codex CLI** persists session / token
data locally, to inform a potential `subfit-ai` adapter. Unlike the
Claude Code and Gemini CLI studies, most of this is compiled from
public documentation rather than direct observation — Codex was not
installed on the authoring machine. Sections marked **[UNVERIFIED]**
need a contributor with a running Codex install to confirm before an
adapter is shipped.

**Primary reference**: `https://developers.openai.com/codex/config-reference`

## 1. Data Locations

Codex CLI uses `~/.codex/` as its configuration / state root. The
variable `$CODEX_HOME` overrides this; when unset, the CLI defaults to
`$HOME/.codex` on Linux / macOS and `%USERPROFILE%\.codex` on Windows.

Confirmed structure (from config reference):

```
~/.codex/
  config.toml           # user config (TOML, not JSON)
  auth.json             # API keys / OAuth tokens
  log/                  # local logs (rotation / retention TBD)
  sessions/             # [UNVERIFIED] — likely location of per-session transcripts
  history/              # [UNVERIFIED] — alt name some versions may use
```

Unlike Claude Code (one JSONL per session under
`~/.claude/projects/<slug>/`) and Gemini CLI (one JSON per session under
`~/.gemini/tmp/<slug>/chats/`), Codex does **not** slot sessions by
workspace slug as far as the public config reference describes. The
flat `sessions/` (or `history/`) layout is the working assumption.

### Project-aware persistence

Codex CLI supports project-scoped state via
`projects.<path>.trust_level` in `config.toml`, but the
`config-reference` doc focuses on trust and approval settings rather
than on-disk session format. That suggests the sessions directory is
**global, not per-project**, and that a future adapter needs to group
sessions by the working directory captured inside each transcript.

## 2. Token Data Format — **[UNVERIFIED]**

The Codex CLI streams OpenAI Responses API events. The Responses API
surfaces usage accounting under `response.usage` with these fields
(documented in the OpenAI API reference, not Codex-specific):

```json
{
  "usage": {
    "input_tokens": 1234,
    "input_tokens_details": { "cached_tokens": 900 },
    "output_tokens": 120,
    "output_tokens_details": { "reasoning_tokens": 40 },
    "total_tokens": 1354
  }
}
```

If Codex writes session transcripts faithfully (working assumption),
each assistant turn would carry a subset of these counts. The expected
mapping to `subfit-ai`'s `ModelTotals`:

| ModelTotals field | Codex source (assumed) |
| --- | --- |
| `inputTokens` | `usage.input_tokens` — `usage.input_tokens_details.cached_tokens` |
| `cacheReadTokens` | `usage.input_tokens_details.cached_tokens` |
| `outputTokens` | `usage.output_tokens` |
| `cacheCreationTokens` | 0 (Codex has no separate cache-write tier — see OpenAI pricing) |

This matches the mapping already used for `codex-standard` and
`codex-priority` in `config.json`: `cacheWrite: 0` is deliberate.

## 3. Session File Format — **[UNVERIFIED]**

Two formats are plausible based on Codex's Responses-API usage:

1. **JSONL stream** — one event per line, similar to Claude Code.
   Easiest for live log append.
2. **Single JSON** — one object per session, similar to Gemini CLI.
   Easier to open for manual inspection.

The adapter in `subfit-ai` should probe both (`.jsonl` and `.json`
extensions under `~/.codex/sessions/`) rather than assume, until the
format is pinned.

The `model` field is expected to be the OpenAI model ID
(`gpt-5.3-codex`, `gpt-5.1-codex-mini`, etc.) and needs a
`normalizeCodexModel` similar to `normalizeGeminiModel`.

## 4. Comparison with Claude Code & Gemini CLI

| Feature | Claude Code | Gemini CLI | Codex CLI |
| --- | --- | --- | --- |
| Storage root | `~/.claude/` | `~/.gemini/` | `~/.codex/` (`$CODEX_HOME` override) |
| Config format | JSON (`.claude/settings.json`) | TOML / JSON mix | **TOML** (`config.toml`) |
| Session root | `projects/<slug>/` | `tmp/<slug>/chats/` | `sessions/` **[UNVERIFIED]** |
| File format | JSONL (one event / line) | JSON (one object / file) | **[UNVERIFIED]** — JSONL or JSON |
| Usage field | `message.usage` | `tokens` | `response.usage` (assumed) |
| Input tokens | `input_tokens` | `input` | `usage.input_tokens` (minus cached) |
| Output tokens | `output_tokens` | `output` | `usage.output_tokens` |
| Cache read | `cache_read_input_tokens` | `cached` | `usage.input_tokens_details.cached_tokens` |
| Cache write | `cache_creation_input_tokens` | — | — (no tier) |
| Reasoning tokens | — | `thoughts` | `usage.output_tokens_details.reasoning_tokens` |
| Project mapping | folder slug | `projects.json` map | project entries in `config.toml` |

## 5. Proposed Adapter for subfit-ai

When a contributor can confirm the session format, the adapter should
mirror the Gemini / Claude layout already present in `subfit-ai.ts`:

1. **Discovery**: `findCodexSessions(root: string)` that walks
   `~/.codex/sessions/` (and `~/.codex/history/` as a fallback) for
   `*.json` / `*.jsonl`, honoring `$CODEX_HOME` when set.
2. **Parsing**: detect per-file whether the content is JSONL (try
   line-split first, then full-file JSON on failure). Extract each
   assistant turn's `usage` block.
3. **Normalization**: `normalizeCodexModel` mapping
   `gpt-5.3-codex` → `codex-standard`, `gpt-5.1-codex-mini`
   → `codex-mini`, `gpt-5.1-codex` → `codex-1` (and possibly a new
   `codex-priority` sibling keyed off a separate tier selector).
4. **Context folding**: reuse `ScanContext` / `mergeContexts` — no new
   machinery needed downstream. Rate/plan entries in `config.json`
   already cover `codex-standard` and `codex-priority`.

Add a `--codex-path` CLI flag analogous to `--gemini-path`, defaulting
to `process.env.CODEX_HOME ?? join(homedir(), ".codex")`, and skip
silently when the directory is absent.

## 6. Open Questions (to resolve before implementation)

- **[UNVERIFIED]** Exact subdirectory: `sessions/` vs `history/` vs
  rolling files under `log/`?
- **[UNVERIFIED]** File format: JSONL or JSON? Both? Compressed?
- **[UNVERIFIED]** Does the transcript retain the Responses-API
  `response.usage` block verbatim, or is it re-encoded / stripped?
- **[UNVERIFIED]** How does Codex represent the cwd / project scope per
  session (folder slug, inline `cwd` field, `git remote`, ...) so a
  future "per-project" view mirrors what Claude and Gemini already do?
- **[UNVERIFIED]** Does `$CODEX_HOME` affect just config or also
  session storage?

## 7. Conclusion

Codex CLI very likely stores enough usage data locally to price it
offline — the Responses API it wraps exposes detailed token accounting,
and `~/.codex/` is already documented as the tool's state root. The
missing piece is **on-disk format** verification. A contributor with a
working Codex install can close this in one PR by:

1. Running a few prompts against Codex.
2. Inspecting `~/.codex/` for the new files.
3. Pasting a redacted sample transcript into a follow-up to this
   document.
4. Implementing `findCodexSessions` / `scanCodexSession` against that
   sample, matching the Gemini adapter's shape.

Until that lands, `subfit-ai` continues to use Codex pricing only as
the *comparison baseline* for Claude and Gemini token volumes — not as
a source of its own usage data.
