# Study: OpenCode CLI Token Storage & Subfit-ai Adapter

This document analyzes how **OpenCode** (the open-source terminal-based
AI coding agent, distinct from OpenAI Codex) persists session / token
data locally, to inform a potential `subfit-ai` adapter. As with the
Codex study, most of the on-disk detail here is compiled from public
documentation rather than direct observation — OpenCode was not
installed on the authoring machine. Sections marked **[UNVERIFIED]**
need a contributor with a running OpenCode install to confirm before
an adapter is shipped.

**Primary references**:

- `https://opencode.ai/docs/` — CLI docs & config
- `https://opencode.ai/docs/zen/` — OpenCode Zen gateway pricing
- `https://opencode.ai/docs/go/` — OpenCode Go subscription

## 1. Data Locations

OpenCode follows the XDG Base Directory spec on Linux / macOS. The
variable `$OPENCODE_HOME` overrides the default state root; when
unset, the CLI defaults to:

```
~/.local/share/opencode/        # state root (sessions, SQLite)
~/.config/opencode/config.json  # user config
```

Expected structure under the state root **[UNVERIFIED]**:

```
~/.local/share/opencode/
  opencode.db                       # SQLite — session index / metadata
  storage/
    session/
      <project-hash>/               # per-workspace grouping
        ses_<session_id>.json       # one JSON object per session
  log/                              # local logs (rotation / retention TBD)
```

Two storage layers appear to coexist:

- **SQLite database** (`opencode.db`) — session index, metadata,
  resumability. Persistence across restarts is an advertised feature,
  and `opencode --session <id>` resumes by ID, so the DB is the
  authoritative lookup surface.
- **JSON session files** under `storage/session/<project-hash>/` —
  one `ses_<id>.json` per session, grouped by a hash of the workspace
  path (analogous to Claude Code's `projects/<slug>/` folders).

Whether token usage is duplicated in both, or lives in one and not the
other, is **[UNVERIFIED]**. The adapter should prefer the JSON files
(no SQLite dependency) and treat the DB as an optional index.

### Project-aware persistence

Unlike flat-layout CLIs (Codex `sessions/`, Claude per-slug folders),
OpenCode's `<project-hash>/` subdirectory means a future adapter can
group usage by workspace **without** parsing transcript bodies. The
hash algorithm (`sha1` of cwd? of git-root?) is **[UNVERIFIED]** and
needs confirmation from a sample install.

## 2. Provider & Pricing Model

OpenCode is **model-agnostic and BYOK (bring-your-own-key)**. It does
not ship its own token pricing; users configure providers in
`~/.config/opencode/config.json` and pay those providers directly.
Relevant for `subfit-ai` positioning:

- **OpenCode Go** — subscription tier gating the OpenCode-hosted
  gateway. **[UNVERIFIED rates]**: $5 first month, then $10/mo, with
  $12/5h, $30/weekly, $60/monthly soft caps published on
  `opencode.ai/docs/go/`.
- **OpenCode Zen** — pay-as-you-go gateway, per-token rates listed at
  `opencode.ai/zen`. No subscription component.
- **Direct provider keys** — Anthropic, OpenAI, Google, etc. Usage
  prices through the provider's public API rates; `subfit-ai` already
  models several of these.

Because pricing depends on which provider each session used, an
OpenCode adapter needs to read a per-turn `provider` + `model` field
out of the session JSON, then dispatch to the matching rates in
`config.json`. This is a bigger lift than the Claude / Gemini / Codex
adapters, each of which assumes a fixed provider.

## 3. Token Data Format — **[UNVERIFIED]**

OpenCode streams assistant messages from whichever upstream API the
session is bound to. The JSON session file is expected to retain each
turn's upstream `usage` block (Anthropic `message.usage`, OpenAI
`response.usage`, Google `usageMetadata`, ...). The adapter will need
a small dispatcher:

```ts
// Pseudocode
switch (turn.provider) {
  case "anthropic":  return extractAnthropicUsage(turn.usage);
  case "openai":     return extractOpenAIUsage(turn.usage);
  case "google":     return extractGoogleUsage(turn.usage);
  case "opencode-zen": return extractZenUsage(turn.usage); // shape TBD
}
```

Whether OpenCode normalises these to a single shape before writing, or
passes them through verbatim, is **[UNVERIFIED]**. Passthrough is more
likely (less work for the CLI, preserves upstream fidelity) and is
what the adapter should assume until proven otherwise.

## 4. Comparison With Existing Adapters

| Feature | Claude Code | Gemini CLI | Vibe | Codex CLI | OpenCode |
| --- | --- | --- | --- | --- | --- |
| Storage root | `~/.claude/` | `~/.gemini/` | `~/.mistral/` (varies) | `~/.codex/` | `~/.local/share/opencode/` |
| Env override | `CLAUDE_CONFIG_DIR` | — | — | `CODEX_HOME` | `OPENCODE_HOME` |
| Config format | JSON | TOML / JSON | JSON | **TOML** | JSON |
| Session index | folder slug | `projects.json` map | folder | flat `sessions/` **[U]** | **SQLite** + folder hash |
| File format | JSONL | JSON | JSON / JSONL | JSONL / JSON **[U]** | JSON **[U]** |
| Provider | Anthropic only | Google only | Mistral only | OpenAI only | **any (BYOK)** |
| Own pricing tier? | Yes (Pro / Max) | Yes (Pro / Ultra) | Yes (Pro) | Yes (Plus / Pro) | Gateway-only (Go / Zen) |
| Usage field | `message.usage` | `tokens` | `usage` | `response.usage` | upstream passthrough **[U]** |

**[U]** = unverified. Each flagged cell needs a sample install to
pin down.

## 5. Proposed Adapter for subfit-ai

Once a contributor confirms the session format, the adapter should
mirror the existing provider-scoped scanners in `subfit-ai.ts` but add
a per-turn provider dispatcher:

1. **Discovery**: `findOpenCodeSessions(root: string)` walks
   `<root>/storage/session/*/ses_*.json`, honoring `$OPENCODE_HOME`
   and falling back to `~/.local/share/opencode/`.
2. **Parsing**: load each session JSON, iterate assistant turns, read
   `(provider, model, usage)` per turn.
3. **Dispatch**: reuse the existing Anthropic / OpenAI / Google usage
   extractors (factor them out of the current per-CLI scanners if
   needed). Google's `usageMetadata` shape is already handled by the
   Gemini scanner — the extraction logic is worth hoisting into
   shared helpers rather than copy-pasting.
4. **Normalization**: map upstream model IDs to the keys already in
   `config.json` (`claude-sonnet-4-6`, `gpt-5.3-codex`,
   `gemini-2.5-pro`, ...). Unknown models get counted but unpriced,
   with a one-line warning (same pattern as the Claude scanner).
5. **Context folding**: emit a `ScanContext` per session; merge via
   the existing `mergeContexts`. No new downstream machinery.

Add `--opencode-path` CLI flag analogous to `--codex-path`, defaulting
to `process.env.OPENCODE_HOME ?? join(homedir(), ".local/share/opencode")`,
and skip silently when the directory is absent.

Pricing entries in `config.json` already cover the upstream models
OpenCode routes to (Anthropic, OpenAI, Google). A **separate** set of
entries is needed for OpenCode Go (subscription) and OpenCode Zen
(per-token) — see §6.

## 6. Subscription Comparison Positioning

`subfit-ai` currently recommends the cheapest provider subscription
that fits observed usage. For OpenCode, the recommendation surface
needs two additions:

- **OpenCode Go** as a flat-rate plan with a 5h / weekly / monthly cap
  triad, similar to how Claude Max plans are modelled.
- **OpenCode Zen** as a pay-as-you-go alternative — no subscription
  column, but a projected monthly cost given observed tokens.

The BYOK path (direct Anthropic / OpenAI / Google keys) is already
covered by the existing provider plans. The interesting comparison is
"does routing through OpenCode Go beat paying each upstream
directly?" — answering that cleanly is the feature that would justify
the adapter.

## 7. Open Questions (to resolve before implementation)

- **[UNVERIFIED]** Does `opencode.db` carry token counts directly, or
  only session metadata + pointers to the JSON files?
- **[UNVERIFIED]** Exact path of the per-session JSON:
  `storage/session/<hash>/ses_<id>.json` vs a flatter layout in newer
  versions?
- **[UNVERIFIED]** Hash algorithm used for the `<project-hash>`
  directory name — needed if the adapter surfaces per-project usage.
- **[UNVERIFIED]** Does each assistant turn carry a `provider` +
  `model` tuple, or is that only recorded at session start?
- **[UNVERIFIED]** Does OpenCode rewrite upstream `usage` blocks into
  a normalised shape, or pass them through verbatim?
- **[UNVERIFIED]** Current OpenCode Go rate card — the figures in §2
  need confirmation against the live docs before landing in
  `config.json` with a `_source` URL (per CLAUDE.md rule 1).
- **[UNVERIFIED]** Retention: does OpenCode rotate / prune old
  sessions, or are they retained indefinitely? Affects the "last N
  days" slicing in `subfit-ai`.

## 8. Feasibility

**Feasibility: high, but more work than prior adapters.**

The heavy lifting — detailed per-turn usage accounting — is already
done upstream by each provider's API, and OpenCode's BYOK model means
those blocks are almost certainly preserved on disk. The state root
is documented (`~/.local/share/opencode/`), the env override
(`OPENCODE_HOME`) is standard, and the project-hash subdirectory
layout is friendlier for per-project reporting than Codex's flat
`sessions/`.

What makes it harder than Claude / Gemini / Codex:

1. **Multi-provider dispatch.** The scanner needs to branch on the
   upstream provider per turn, not per CLI. This also means factoring
   the existing single-provider extractors into reusable helpers.
2. **Two pricing modes.** Go (flat) and Zen (per-token) both need
   entries in `config.json`, and the subscription-comparison logic
   needs a new "pay-as-you-go" column for Zen.
3. **SQLite noise.** The DB exists but shouldn't become a dependency.
   The adapter should ignore it and stick to JSON files.

A contributor with a running OpenCode install can close this in one
PR by:

1. Running prompts against OpenCode with at least two different
   upstream providers (e.g. Anthropic + OpenAI).
2. Pasting a redacted sample `ses_<id>.json` into a follow-up to this
   document.
3. Confirming the Go / Zen rate cards against live docs and updating
   `config.json` with `_source` URLs.
4. Implementing `findOpenCodeSessions` / `scanOpenCodeSession` against
   that sample, factoring shared provider-usage extractors.

Until that lands, `subfit-ai` treats OpenCode as a comparison target
only — its Go and Zen rates (once confirmed) can ride alongside the
existing plan entries without needing the scan path.
