# Study: Mistral Vibe CLI Token Storage & Subfit-ai Adapter

This document analyzes how **Mistral Vibe CLI** persists session / token
data locally, to inform a potential `subfit-ai` adapter. Unlike the
Claude Code and Gemini CLI studies, most of this is compiled from
public documentation — Vibe was not installed on the authoring machine.
Sections marked **[UNVERIFIED]** need a contributor with a working
Vibe install (or source inspection) to confirm before an adapter
ships.

**Primary references**:

- `https://docs.mistral.ai/mistral-vibe/introduction`
- `https://mistral.ai/pricing`
- `https://github.com/mistralai/mistral-vibe` (the CLI is open source —
  the exact session format can be read straight from the source rather
  than inferred)

## 1. Data Locations

Vibe CLI uses `~/.vibe/` as its configuration / state root. The
variable `$VIBE_HOME` overrides this; when unset, the CLI falls back to
`$HOME/.vibe` on Linux / macOS and `%USERPROFILE%\.vibe` on Windows.

Confirmed from the public docs:

```
~/.vibe/
  logs/                 # session transcripts / chat history live here
  <config files>        # [UNVERIFIED] — exact names TBD
```

Unlike Claude Code (one JSONL per session under
`~/.claude/projects/<slug>/`) and Gemini CLI (one JSON per session
under `~/.gemini/tmp/<slug>/chats/`), the published docs do not spell
out whether Vibe slots sessions by workspace. Given Vibe is open
source, a contributor can confirm by reading the CLI's own "session
open" / "session write" path rather than guessing.

## 2. Models & Pricing

Vibe currently exposes two Devstral models. The raw per-token rates
live on Mistral's pricing page; the relevant figures as of this
study:

| Model                 | Parameters | Input $/1M | Output $/1M |
| --- | ---: | ---: | ---: |
| Devstral 2            | 123 B      | 0.40 | 2.00 |
| Devstral Small 2      | 24 B       | 0.10 | 0.30 |

**Important caveat**: at the time of writing, Vibe is **free during
the launch period** — users do not actually get billed for tokens
produced through the CLI. Any `subfit-ai` report based on these rates
is a "what-if metered" view (same framing as the Claude subscription
vs API comparison), not a bill.

Cache read / cache write tiers are not documented for Devstral. The
adapter should default those to `0` the same way Codex entries do in
`config.json`, until Mistral publishes a cache policy.

## 3. Token Data Format — **[UNVERIFIED]**

Mistral Vibe wraps the standard Mistral Chat Completions API, which
surfaces usage accounting as:

```json
{
  "usage": {
    "prompt_tokens": 1234,
    "completion_tokens": 120,
    "total_tokens": 1354
  }
}
```

If Vibe persists API responses verbatim, each assistant turn in
`~/.vibe/logs/` is expected to carry a subset of those fields. The
expected mapping to `subfit-ai`'s `ModelTotals`:

| ModelTotals field | Vibe source (assumed) |
| --- | --- |
| `inputTokens`         | `usage.prompt_tokens` |
| `outputTokens`        | `usage.completion_tokens` |
| `cacheReadTokens`     | 0 (no documented cache field) |
| `cacheCreationTokens` | 0 (Devstral has no cache-write tier) |

If Vibe exposes a richer accounting (reasoning tokens, cached
prompt tokens), the adapter should map those through the same
pattern used for Codex' `response.usage.input_tokens_details.cached_tokens`.

## 4. Session File Format — **[UNVERIFIED]**

Three plausible formats, given the CLI's behaviour of writing to a
`logs/` directory:

1. **One JSON per session** — similar to Gemini CLI, easy for manual
   inspection.
2. **JSONL stream** — similar to Claude Code, one event per line.
3. **Rotating log files** (e.g. `vibe.log`, `vibe.log.1`) mixing
   prompts, responses, and metadata — the directory name `logs/`
   nudges this way.

The adapter should probe all three (`.json`, `.jsonl`, any extension
at all) and let the open-source CLI source settle the question
before shipping.

The `model` field is expected to be the Mistral model ID
(`devstral-2`, `devstral-small-2`, or similar). A
`normalizeVibeModel()` helper will need to map them to the
`vibe-devstral-2` / `vibe-devstral-small-2` pricing keys that an
adapter PR would add to `config.json`.

## 5. Comparison with Claude Code, Gemini CLI, and Codex CLI

| Feature | Claude Code | Gemini CLI | Codex CLI | Vibe CLI |
| --- | --- | --- | --- | --- |
| Storage root | `~/.claude/` | `~/.gemini/` | `~/.codex/` (`$CODEX_HOME`) | `~/.vibe/` (`$VIBE_HOME`) |
| Config format | JSON (`settings.json`) | TOML / JSON mix | TOML (`config.toml`) | **[UNVERIFIED]** |
| Session root | `projects/<slug>/` | `tmp/<slug>/chats/` | `sessions/` **[UNVERIFIED]** | `logs/` **[UNVERIFIED]** |
| File format | JSONL (one event / line) | JSON (one object / file) | **[UNVERIFIED]** | **[UNVERIFIED]** |
| Usage field | `message.usage` | `tokens` | `response.usage` (assumed) | `usage` (assumed, Mistral API shape) |
| Input tokens | `input_tokens` | `input` | `usage.input_tokens` (minus cached) | `usage.prompt_tokens` |
| Output tokens | `output_tokens` | `output` | `usage.output_tokens` | `usage.completion_tokens` |
| Cache read | `cache_read_input_tokens` | `cached` | `usage.input_tokens_details.cached_tokens` | — (not documented) |
| Cache write | `cache_creation_input_tokens` | — | — (no tier) | — (no tier) |
| License | closed | closed | closed | **open source** |

The last row is the big adapter-writing advantage Vibe has over the
others: the contributor doesn't have to guess — they can read the
session-persistence code directly.

## 6. Proposed Adapter for subfit-ai

When the session format is pinned, the adapter should mirror the
Gemini / Claude layout already present in `subfit-ai.ts`:

1. **Discovery**: `findVibeSessions(root: string)` that walks
   `~/.vibe/logs/` for transcript files, honoring `$VIBE_HOME` when
   set.
2. **Parsing**: detect per-file whether the content is JSONL (try
   line-split first, then full-file JSON on failure). Extract each
   assistant turn's `usage` block.
3. **Normalization**: `normalizeVibeModel` mapping
   `devstral-2` → `vibe-devstral-2`,
   `devstral-small-2` → `vibe-devstral-small-2`.
4. **Context folding**: reuse `ScanContext` / `mergeContexts` — no new
   machinery needed downstream.

Add a `--vibe-path` CLI flag analogous to `--gemini-path`, defaulting
to `process.env.VIBE_HOME ?? join(homedir(), ".vibe")`, and skip
silently when the directory is absent.

When the adapter lands, add two entries to `config.json` /
`default-config.json`:

```json
"vibe-devstral-2":       { "label": "Mistral Devstral 2 (123B)",   "input": 0.40, "output": 2.00, "cacheWrite": 0,
                           "_source": "https://mistral.ai/pricing" },
"vibe-devstral-small-2": { "label": "Mistral Devstral Small 2 (24B)", "input": 0.10, "output": 0.30, "cacheWrite": 0,
                           "_source": "https://mistral.ai/pricing" }
```

If Mistral continues to bill $0 during the launch period, note this
in the `note` field so users aren't surprised when the `Provider $`
column reads "what it would cost at the published rate, not what
you were charged".

## 7. Open Questions (to resolve before implementation)

- **[UNVERIFIED]** Exact subdirectory of sessions: `logs/` only, or
  a slugged layout like Gemini?
- **[UNVERIFIED]** File format: JSONL, JSON, or rotating text logs?
- **[UNVERIFIED]** Does Vibe persist the Mistral API `usage` block
  verbatim, or re-encode it?
- **[UNVERIFIED]** Does `$VIBE_HOME` affect config only, sessions
  only, or both?
- **[UNVERIFIED]** Is there a per-project scoping field inside each
  transcript so a future per-project view mirrors what Claude and
  Gemini already do?
- **[UNVERIFIED]** Does Vibe retain cache / reasoning token fields if
  Mistral adds them to the API later?

## 8. Conclusion

Vibe is attractive for a `subfit-ai` adapter because the CLI is
open source — the session format can be verified by reading the
source rather than by probing a running install. Combined with
Mistral's straightforward `usage` block from the Chat Completions
API, the mapping to `ModelTotals` should be close to the Gemini
adapter in scope. The main user-facing subtlety is the launch-period
$0 billing: the `Provider $` column will be an *at-published-rate*
estimate, not an invoice.
