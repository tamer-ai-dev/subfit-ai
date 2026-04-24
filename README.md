# subfit-ai

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](./package.json)
[![Tested with Claude Code](https://img.shields.io/badge/tested%20with-Claude%20Code-8A2BE2.svg)](https://claude.ai/code)

**find the plan that fits your usage.**

## What it does

`subfit-ai` scans your local **Claude Code**, **Gemini CLI**, **Mistral
Vibe CLI**, **OpenAI Codex CLI**, and **OpenCode CLI** session history,
prices the same token volume on OpenAI Codex rates, and checks which
subscription tier
— Claude Pro / Max 5x / Max 20x / Team / Enterprise, or OpenAI Plus /
Pro / Pro 20x — your real 5-hour usage actually fits into. It runs
entirely offline against the session files (JSONL for Claude,
JSON/JSONL for Gemini, Vibe, Codex, and OpenCode) the five CLIs already
write to disk.

## Report
```
── Scan summary ──
Provider  Files  Entries  Messages  With tokens  Parse-errors  Date range
────────  ─────  ───────  ────────  ───────────  ────────────  ───────────────────────
Claude    847    362,140  90,320    90,320       0             2026-03-22 → 2026-04-22
Gemini    50     28,420   24,750    24,750       0             2026-03-22 → 2026-04-22
Vibe      20     11,450   10,000    10,000       0             2026-03-22 → 2026-04-22
Codex     30     6,840    6,010     6,010        0             2026-03-22 → 2026-04-22
TOTAL     947    408,850  131,080   131,080      0
Tokens: 11.4M input, 56.2M output, 15.9B cache-read, 184M cache-write (all providers combined)
Config: ./config.json

── Subscription comparison ──
Your usage: 131,080 assistant messages over 30.0 days
  ≈ 4369.3 msgs/day  ≈ 910.3 msgs per 5h window

Plan                Price/mo  5h limit   Fits your avg?                                        Note
──────────────────  ────────  ─────────  ────────────────────────────────────────────────────  ────────────────────────────────────
Claude Pro          $20       10-45      EXCEEDS by 20.2x (avg 910.3 > high bound 45)          40-45 observed, shared across products
Claude Max 5x       $100      225+       EXCEEDS by 4.0x (avg 910.3 > baseline 225+)           225+ baseline, 50 sessions/mo cap
Claude Max 20x      $200      900+       EXCEEDS by 1.0x (avg 910.3 > baseline 900+)           900+ baseline, 50 sessions/mo cap
...
OpenAI Pro 20x      $200      200-1200   FITS at high-usage tier (avg 910.3 within [200-1200]) Codex cloud tasks / 5h
Mistral Free        $0        6+         EXCEEDS by 151.7x (avg 910.3 > baseline 6+)           6 free messages per day
Mistral Pro         $15       unlimited  unlimited — fits                                      Vibe for all-day coding

Sessions: 947 total over 2 month(s) (avg 473.5/mo). Max plans cap at 50 sessions/mo.
  ⚠ EXCEEDS 50 sessions/mo cap on Claude Max plans

→ Best fit: Mistral Pro at $15/mo — unlimited 5h throughput
```

## How it works

**Data source: local session files only.** Three sources are scanned
in parallel and merged into a single report:

- **Claude Code** appends one JSON event per line to
  `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl` (one file per
  session, JSONL format). See
  [`docs/claude-pricing.md`](docs/claude-pricing.md) for the plan
  tiers, 5h-window model, and what `subfit-ai` treats as a "message"
  (distinct `requestId`, not raw JSONL lines).
- **Gemini CLI** writes one JSON object per session to
  `~/.gemini/tmp/<slug>/chats/session-*.json` (full JSON, one file per
  session). See `docs/studies/STUDY-gemini-tokens.md` for the format
  details.
- **Mistral Vibe CLI** writes session transcripts under
  `~/.vibe/logs/` (the exact shape is [not verified][vibe-unverified]
  on a live install; the scanner probes both full-file JSON and
  line-by-line JSONL and maps the Mistral API `usage` block —
  `prompt_tokens` / `completion_tokens` / `cached_tokens`). Honours
  `$VIBE_HOME` if set. See `docs/studies/STUDY-vibe-tokens.md`.
- **OpenAI Codex CLI** writes session transcripts under
  `~/.codex/sessions/` (or `history/`), again in a shape that is
  [not verified][codex-unverified] here; the scanner probes JSON and
  JSONL and maps the OpenAI Responses-API `usage` block —
  `input_tokens` / `output_tokens` /
  `input_tokens_details.cached_tokens`. The cached subset is
  subtracted from the total input so the downstream cost math does
  not double-count. Honours `$CODEX_HOME` if set. See
  `docs/studies/STUDY-codex-tokens.md`.
- **OpenCode CLI** writes per-session JSON under
  `~/.local/share/opencode/storage/session/<project-hash>/ses_*.json`.
  The on-disk shape is [not verified][opencode-unverified] here;
  OpenCode is **BYOK**, so each turn is routed to the upstream provider
  it actually hit (Anthropic / Google / OpenAI / Mistral) via an
  explicit `provider` hint on the turn or a fallback model-string
  sniff, and the usage block is then read in that provider's shape.
  Honours `$OPENCODE_HOME` if set. See
  `docs/studies/STUDY-opencode-tokens.md`.

[vibe-unverified]: docs/studies/STUDY-vibe-tokens.md#4-session-file-format--unverified
[codex-unverified]: docs/studies/STUDY-codex-tokens.md#3-session-file-format--unverified
[opencode-unverified]: docs/studies/STUDY-opencode-tokens.md#3-token-data-format--unverified

**`subfit-ai` makes no network calls at runtime.** The Docker image and
the `npx` invocation both download dependencies (`tsx`, `vitest`, etc.)
at *build* / *install* time via npm; once the tool is launched it does
not reach Anthropic, Google, OpenAI, or any other remote service.
There is no API export, no telemetry, no third-party aggregator. If
either CLI has run on this machine, the data is already on disk and
`subfit-ai` can price it. If a provider's root directory does not
exist, that side is skipped silently; there is no "only Claude" or
"only Gemini" mode switch.

On the **Claude** side, every assistant turn carries token counts under
`message.usage`:

```json
{
  "type": "assistant",
  "timestamp": "2026-04-22T20:15:09.015Z",
  "message": {
    "model": "claude-opus-4-7",
    "usage": {
      "input_tokens": 6,
      "output_tokens": 228,
      "cache_read_input_tokens": 16446,
      "cache_creation_input_tokens": 57591
    }
  }
}
```

On the **Gemini** side, each `messages[]` entry with `type: "gemini"`
carries its counts under `tokens` (with `cached` as the cache-read
equivalent; Gemini has no cache-write tier):

```json
{
  "type": "gemini",
  "timestamp": "2026-04-23T06:57:24.342Z",
  "model": "gemini-3-flash-preview",
  "tokens": { "input": 7249, "output": 83, "cached": 5722, "total": 7585 }
}
```

`subfit-ai` walks `~/.claude` recursively, picks every `*.jsonl` at any
depth, keeps only lines where `type === "assistant"` with a
`message.usage` block, sums the four token counts per model and per
YYYY-MM, and computes:

1. **What the same tokens would cost at each provider's API rates** —
   Anthropic rates for Claude models (Opus / Sonnet / Haiku, with
   cache-read and cache-creation priced separately) and Google rates
   for Gemini models (Pro / Flash / Flash-Lite). This is a *what-if
   metered* view, not what you actually paid if you are on a
   subscription.
2. **What OpenAI Codex would charge** — at `gpt-5.3-codex` standard and
   priority rates on the same token volume.
3. **Whether your usage fits under a subscription** — compares your average
   messages per 5-hour window against the real Claude and OpenAI caps.

**Sources for the numbers**:

- Claude subscription caps (Pro, Max 5x / 20x, Team, Enterprise):
  [Anthropic support article #11014257](https://support.anthropic.com/en/articles/11014257).
  The `225+` / `900+` baselines on Claude Max 5x / 20x come directly from
  that article — they are Anthropic's documented figures, not personal
  observations.
- Claude API token rates: Anthropic's published pricing page.
- OpenAI Codex rates and subscription caps: OpenAI's pricing page.

## How to use

Run with `npx tsx` (no install needed — requires Node 18+):

```bash
npx tsx ./subfit-ai.ts                           # scan ~/.claude, ~/.gemini, ~/.vibe, ~/.codex AND ~/.local/share/opencode
npx tsx ./subfit-ai.ts --demo                    # use bundled examples/sample.jsonl
npx tsx ./subfit-ai.ts --path /custom            # override the Claude scan root
npx tsx ./subfit-ai.ts --gemini-path /other      # override the Gemini scan root
npx tsx ./subfit-ai.ts --vibe-path /elsewhere    # override the Vibe scan root
npx tsx ./subfit-ai.ts --codex-path /foo         # override the Codex scan root
npx tsx ./subfit-ai.ts --opencode-path /bar      # override the OpenCode scan root
npx tsx ./subfit-ai.ts --config my.json        # custom pricing / plan file
npx tsx ./subfit-ai.ts --json             # machine-readable output
npx tsx ./subfit-ai.ts --no-monthly       # skip the per-month table
npx tsx ./subfit-ai.ts --export           # write ./subfit-report.md (GFM)
npx tsx ./subfit-ai.ts --export out.md    # write to a custom path
npx tsx ./subfit-ai.ts --json --export    # JSON to stdout + Markdown file
npx tsx ./subfit-ai.ts --help
```

If you haven't run Claude Code yet, `--demo` scans a synthetic
`examples/sample.jsonl` (50 fake assistant messages across Opus / Sonnet /
Haiku, spanning 3 months) so you can see the full output shape without any
real session data.

Or install it as a bin with `npm link` and call `subfit-ai` directly — the
script carries a `#!/usr/bin/env -S npx tsx` shebang so there is no
compile step.

**Platform support**: tested on Linux and macOS. On native Windows, the
`env -S` shebang is not honored by `cmd.exe`, so run the script via
`npx tsx ./subfit-ai.ts …` or from a WSL shell. `npm link` still works
on Windows — npm generates a `.cmd` wrapper that calls `tsx` directly.

**CLI options**:

| Flag | Default | Description |
| --- | --- | --- |
| `--path <dir>` | `~/.claude` | Claude Code scan root — recursively globs `*.jsonl` |
| `--gemini-path <dir>` | `~/.gemini` | Gemini CLI scan root — globs `tmp/<slug>/chats/session-*.json`; skipped silently if missing |
| `--vibe-path <dir>` | `$VIBE_HOME` or `~/.vibe` | Mistral Vibe CLI scan root — recursively globs `logs/**/*.{json,jsonl}`; skipped silently if missing |
| `--codex-path <dir>` | `$CODEX_HOME` or `~/.codex` | OpenAI Codex CLI scan root — prefers `sessions/` / `history/` for `*.{json,jsonl}`, falls back to a root scan; skipped silently if missing |
| `--opencode-path <dir>` | `$OPENCODE_HOME` or `~/.local/share/opencode` | OpenCode CLI scan root — prefers `storage/session/**/ses_*.json`, falls back to a root scan (skipping `opencode.db` / `log/`); BYOK-routed to the upstream provider; skipped silently if missing |
| `--config <file>` | `./config.json` | Pricing + plan-limits config; falls back to the embedded `default-config.json` if missing or malformed |
| `--json` | off | Emit a single JSON object instead of terminal tables |
| `--no-monthly` | off | Skip the YYYY-MM breakdown |
| `--export [file]` | — | Write a Markdown (GFM) report; path defaults to `./subfit-report.md`, **overwrites** existing files with a stderr warning |
| `--demo` | off | Scan `examples/sample.jsonl` bundled with the script instead of `--path` — zero setup |
| `-v`, `--version` | — | Print the package version and exit |
| `-h`, `--help` | — | Print the built-in help |

## Example output

> The figures below are fictional — they show the layout, not real usage data.

```
── Scan summary ──
Provider  Files  Entries  Messages  With tokens  Parse-errors  Date range
────────  ─────  ───────  ────────  ───────────  ────────────  ───────────────────────
Claude    847    362,140  90,320    90,320       0             2026-03-22 → 2026-04-22
Gemini    50     28,420   24,750    24,750       0             2026-03-22 → 2026-04-22
Vibe      20     11,450   10,000    10,000       0             2026-03-22 → 2026-04-22
Codex     30     6,840    6,010     6,010        0             2026-03-22 → 2026-04-22
TOTAL     947    408,850  131,080   131,080      0
Tokens: 11.4M input, 56.2M output, 15.9B cache-read, 184M cache-write (all providers combined)
Config: ./config.json

── Subscription comparison ──
Your usage: 131,080 assistant messages over 30.0 days
  ≈ 4369.3 msgs/day  ≈ 910.3 msgs per 5h window

Plan                Price/mo  5h limit   Fits your avg?                                        Note
──────────────────  ────────  ─────────  ────────────────────────────────────────────────────  ────────────────────────────────────
Claude Pro          $20       10-45      EXCEEDS by 20.2x (avg 910.3 > high bound 45)          40-45 observed, shared across products
Claude Max 5x       $100      225+       EXCEEDS by 4.0x (avg 910.3 > baseline 225+)           225+ baseline, 50 sessions/mo cap
Claude Max 20x      $200      900+       EXCEEDS by 1.0x (avg 910.3 > baseline 900+)           900+ baseline, 50 sessions/mo cap
Claude Team         $30       10-45      EXCEEDS by 20.2x (avg 910.3 > high bound 45)          similar to Pro, per seat
Claude Enterprise   custom    unlimited  unlimited — fits                                      custom pricing, unlimited
OpenAI Plus         $20       10-60      EXCEEDS by 15.2x (avg 910.3 > high bound 60)          Codex cloud tasks / 5h
OpenAI Pro          $100      50-300     EXCEEDS by 3.0x (avg 910.3 > high bound 300)          Codex cloud tasks / 5h
OpenAI Pro 20x      $200      200-1200   FITS at high-usage tier (avg 910.3 within [200-1200]) Codex cloud tasks / 5h
Mistral Free        $0        6+         EXCEEDS by 151.7x (avg 910.3 > baseline 6+)           6 free messages per day
Mistral Pro         $15       unlimited  unlimited — fits                                      Vibe for all-day coding
Mistral Team        $25       unlimited  unlimited — fits                                      $24.99/user/mo
Mistral Enterprise  custom    unlimited  unlimited — fits                                      custom pricing

Sessions: 947 total over 2 month(s) (avg 473.5/mo). Max plans cap at 50 sessions/mo.
  ⚠ EXCEEDS 50 sessions/mo cap on Claude Max plans

→ Best fit: Mistral Pro at $15/mo — unlimited 5h throughput

── Per model ──
Model              Msgs     In    Out    CacheR  CacheW  Provider $  Codex-Std $  Codex-Pri $  Ratio
─────────────────  ───────  ────  ─────  ──────  ──────  ──────────  ───────────  ───────────  ─────
Claude Opus 4      85,200   7.8M  38.5M  11.2B   173M    $7312.45    $2523.14     $41247.88    0.35x
Gemini 2.5 Pro     19,850   1.8M   8.9M   2.6B   —       $380.21     $512.47      $8247.92     1.35x
Claude Sonnet 4     5,120   412k   2.1M   670M   11.2M   $276.83     $154.22      $2521.14     0.56x
OpenAI Codex        6,010   387k   1.8M   890M   —       $181.43     $181.43      $2903.56     1.00x
Devstral 2          7,850   512k   2.4M   —      —       $5.00       $34.17       $547.52      6.83x
Gemini 2.5 Flash    4,900   380k   1.7M   520M   —       $4.36       $133.80      $2150.72     30.69x
Devstral Small 2    2,150   142k   812k   —      —       $0.26       $11.62       $185.86      44.69x
TOTAL             131,080  11.4M  56.2M  15.9B   184M    $8160.54    $3550.85     $57804.60    0.44x

── Per month ──
Month    Msgs     In    Out    Provider $  Codex-Std $  Ratio
───────  ───────  ────  ─────  ──────────  ───────────  ─────
2026-03  33,020    2.9M  14.1M  $2054.12    $894.12      0.44x
2026-04  98,060    8.5M  42.1M  $6106.42   $2656.73      0.44x
TOTAL   131,080   11.4M  56.2M  $8160.54   $3550.85      0.44x

Ratio column: Codex-Std cost divided by the Provider cost on the same tokens.
  <1.0  → Codex cheaper than the native provider on this volume
  >1.0  → Native provider cheaper than Codex on this volume

⚠ Claude subscription limits are documented baselines, not guarantees. Community
  reports indicate they can deplete faster than expected on some workloads.
  If your avg is within 20% of a plan limit, expect occasional throttling.
```

The terminal output leads with the subscription verdict (the question you
came to answer) and the per-model / per-month tables follow as supporting
evidence. Under the comparison table:

- **Sessions line**: total distinct JSONL files (≈ Claude sessions) seen,
  the months they span, and the resulting `avg N/mo`. If the average
  exceeds 50, Claude Max plans will hit the session cap even when their
  5h verdict says FITS — this is why the example above recommends
  Mistral Pro at $15/mo (unlimited, no session cap) over every Claude
  Max tier or the pricier OpenAI Pro 20x.
- **Volatility warning**: Claude subscription limits are documented
  baselines, not guarantees — community reports describe them depleting
  faster than expected on some workloads.
- **Best fit**: the cheapest plan whose 5h verdict is FITS **and** whose
  session cap (if any) is not exceeded. A plan within 20% of its 5h
  ceiling is flagged `MARGINAL (N% of limit)` rather than FITS and is
  **not eligible** to be the best fit — the 20% headroom is a throttling
  buffer. If the cheapest option is marginal, the recommendation line
  annotates the trade-off. If nothing qualifies, it reads
  `No plan comfortably fits — consider Enterprise or reducing usage`.

## Configuration

Rates and plan caps live in **`config.json`** next to the script:

```json
{
  "pricing": {
    "claude-opus-4":    { "label": "Claude Opus 4", "input": 5.0, "output": 25.0, "cacheRead": 0.50, "cacheWrite": 6.25 },
    "claude-sonnet-4":  { "label": "Claude Sonnet 4", "input": 3.0, "output": 15.0, "cacheRead": 0.30, "cacheWrite": 3.75 },
    "claude-haiku-4-5": { "label": "Claude Haiku 4.5", "input": 1.0, "output": 5.0, "cacheRead": 0.10, "cacheWrite": 1.25 },
    "codex-standard":   { "label": "OpenAI Codex (gpt-5.3-codex) standard", "input": 1.75, "cacheRead": 0.175, "cacheWrite": 0, "output": 14.0 },
    "codex-priority":   { "label": "OpenAI Codex (gpt-5.3-codex) priority", "input": 3.50, "cacheWrite": 0, "output": 28.0 },
    "gemini-pro":        { "label": "Gemini 2.5 Pro",        "input": 1.00, "output": 10.00, "cacheRead": 0.10, "cacheWrite": 0 },
    "gemini-flash":      { "label": "Gemini 2.5 Flash",      "input": 0.30, "output": 2.50,  "cacheRead": 0.03, "cacheWrite": 0 },
    "gemini-flash-lite": { "label": "Gemini 2.5 Flash-Lite", "input": 0.10, "output": 0.40,  "cacheRead": 0.01, "cacheWrite": 0 }
  },
  "planLimits": {
    "claude-pro":        { "label": "Claude Pro",        "monthlyUsd": 20,   "messagesPer5h": [10, 45] },
    "claude-max-5x":     { "label": "Claude Max 5x",     "monthlyUsd": 100,  "messagesPer5h": [225, null], "sessionsCap": 50 },
    "claude-max-20x":    { "label": "Claude Max 20x",    "monthlyUsd": 200,  "messagesPer5h": [900, null], "sessionsCap": 50 },
    "claude-team":       { "label": "Claude Team",       "monthlyUsd": 30,   "messagesPer5h": [10, 45] },
    "claude-enterprise": { "label": "Claude Enterprise", "monthlyUsd": null, "messagesPer5h": null },
    "openai-plus":       { "label": "OpenAI Plus",       "monthlyUsd": 20,   "messagesPer5h": [10, 60] },
    "openai-pro":        { "label": "OpenAI Pro",        "monthlyUsd": 100,  "messagesPer5h": [50, 300] },
    "openai-pro-20":     { "label": "OpenAI Pro 20x",    "monthlyUsd": 200,  "messagesPer5h": [200, 1200] }
  }
}
```

> The real `config.json` / `default-config.json` also carry `_source`
> URLs on each Claude, Gemini, and OpenAI-plan entry (Anthropic support
> article / Gemini pricing page / OpenAI pricing page) — omitted here
> for readability.

All rates are **USD per 1M tokens**. `cacheRead` and `cacheWrite` fall back
to `input` if omitted. For plan limits:

- `monthlyUsd: null` → custom pricing (Enterprise), rendered as `custom`.
- `messagesPer5h: null` → truly unlimited (rate-limited only).
- `messagesPer5h: [lo, hi]` → fixed band; verdict compares against both bounds.
- `messagesPer5h: [lo, null]` → `lo+` baseline with no published ceiling
  (Claude Max tiers); verdict compares against `lo` only and the limit is
  rendered as `225+` / `900+`.
- `sessionsCap: N` (optional) → max sessions per month before the plan is
  excluded from the best-fit recommendation, even if the 5h verdict says
  FITS. Claude Max 5x and 20x use `50`.

**OpenAI Codex has no separate cache-write fee**: cached-input discount is
the only cache tier the public price list advertises. The Codex entries set
`cacheWrite: 0` explicitly — without that, the `cacheWrite ?? input`
fallback in `costOn()` would silently bill cache-creation tokens at the
full input rate and overstate the Codex cost.

If `config.json` is missing or malformed, `subfit-ai` falls back to an
embedded snapshot (`default-config.json`) and keeps running — the header
prints `config: embedded defaults`.

**Ratio column**: `Codex-Std $` divided by the native Provider cost on
the same tokens. It is a **cost ratio, not a savings percentage** —
`0.12x` means the provider (Anthropic for Claude models, Google for
Gemini) cost 8× what Codex would have cost on that volume, not "12%
savings". Read it as:

- `<1.0` → Codex would have been cheaper on that volume
- `>1.0` → The native provider was the cheaper one

`cache_read_input_tokens` is usually the dominant count in Claude
sessions (reading cached context); the comparison is apples-to-apples
per provider's own cache policy.

## Updating plan data

Token rates, subscription prices, and the 5-hour / session limits change
regularly. Rather than keep the numbers in sync manually, feed the current
state back through Claude. Paste the prompt below into a fresh Claude
chat, let it research, and replace **both** `config.json` and
`default-config.json` with the JSON it returns.

```
Refresh the `subfit-ai` pricing snapshot. Research from these canonical
sources (open each one and cross-reference against recent changelog /
blog posts — pricing pages often lag behind announcements):

  Claude API models .............. https://docs.anthropic.com/en/docs/about-claude/pricing
  Claude subscriptions ........... https://support.anthropic.com/en/articles/11014257
  OpenAI Codex ................... https://developers.openai.com/codex/pricing
  OpenAI subscriptions (Plus/Pro). https://openai.com/pricing
  Gemini ......................... https://ai.google.dev/gemini-api/docs/pricing
  Mistral / Vibe ................. https://mistral.ai/pricing

Return:

1. Per-model token pricing (USD per 1M tokens), with a separate `cacheRead` and
   `cacheWrite` field where the provider breaks cache tiers out:
     Claude ........ Opus, Sonnet, Haiku (current minor versions)
     OpenAI Codex .. GPT-5.x Codex standard AND priority (or priority==null)
     Gemini ........ 2.5 Pro, 2.5 Flash, 2.5 Flash-Lite
     Mistral ....... Devstral 2, Devstral Small 2

2. Subscription plans with monthly price, 5-hour message limits, and session
   caps for each:
     Claude ........ Pro, Max 5x, Max 20x, Team, Enterprise
     OpenAI ........ Plus, Pro, Pro 20x
     Mistral ....... Free, Pro, Team, Enterprise

3. Check carefully for subtleties before reporting a rate:
   • **Cache tiers by duration** — some providers charge different rates for
     short (5 min) vs long (1 h) cache entries. Capture the most common tier.
   • **Batch API discounts** — usually a flat 50% off listed rates, sometimes
     not available on every model. Note this in the `note` field if it applies.
   • **Long-context multipliers** — Gemini 2.5 Pro doubles above 200K ctx.
     Claude and OpenAI occasionally add similar bands. Capture the ≤200K rate
     as the primary; mention the long-context band in `note`.
   • **Free tier vs paid tier limits** — the free-tier message cap is often
     advertised as "per day" rather than "per 5h"; normalize it into
     messagesPer5h: [lo, null] (baseline with no published ceiling) and
     record the original phrasing in `note`.
   • **Session / monthly caps** — Claude Max ships a 50 sessions/mo cap that
     is separate from the 5h limit. Capture it in `sessionsCap`.
   • **Recent changes** — scan the last 30 days of each provider's blog /
     changelog. The pricing page is sometimes stale by several weeks.

4. Format the JSON result to match the existing config shape exactly:
{
  "pricing": { "<model-key>": { "label": "...", "input": N, "output": N, "cacheRead": N, "cacheWrite": N, "_source": "<url>" } },
  "planLimits": { "<plan-key>": { "label": "...", "monthlyUsd": N|null, "messagesPer5h": [lo,hi]|[lo,null]|null, "sessionsCap": N|null, "note": "...", "_source": "<url>" } }
}

Include a `_source` URL on every entry. If a number is unverified after
cross-referencing, flag it in `note` with "unverified, check <url>" rather
than guessing.
```

Keep the two files byte-identical — `config.json` is what users edit,
`default-config.json` is the fallback the binary embeds when the user's
`config.json` is missing or malformed. Re-run `subfit-ai --json` after the
update to sanity-check the numbers before committing.

**Source of truth for Claude limits**:
[Anthropic support article #11014257](https://support.anthropic.com/en/articles/11014257).
The `225+` / `900+` baselines on Claude Max 5x / 20x come directly from
that article. The Claude Max entries in both config files carry a
`_source` field pointing to this article so the provenance stays visible
inside the config.

### Future: quality-adjusted comparison (TODO)

Raw token pricing does not tell the whole story. A $0.40/M model that
needs 3× more rounds to produce working code is not actually cheaper
than a $5/M model that gets it right first try. A future version
should include a quality / efficiency weighting factor — e.g.
"effective cost per successful task" — informed by community
benchmarks (SWE-bench, Aider leaderboard, etc.). Contributions
welcome.

## Comparison landscape

_Snapshot as of 2026-04-23. Provider pricing changes frequently — verify
against each vendor's current pricing page before relying on these numbers._

`subfit-ai` currently compares Claude (API + subscriptions) against OpenAI
Codex (API + Plus / Pro / Pro 20x). The coding-assistant market is wider
than that — the snapshot below is for orientation, not a feature list.
Pull requests that wire any of these into `config.json` (or teach the
scanner to read other tools' session formats) are welcome.

**OpenAI Codex** — source: `developers.openai.com/codex/pricing`.

| Model | Input $/1M | Output $/1M | Cached input | Cache write |
| --- | ---: | ---: | ---: | ---: |
| GPT-5.3 Codex | 1.75 | 14.00 | 0.875 (50% of input) | none |
| GPT-5.1 Codex | 1.25 | 10.00 | — | none |
| GPT-5.1 Codex Mini | 0.25 | 2.00 | — | none |

**Google Gemini** — source: `ai.google.dev/gemini-api/docs/pricing`.

| Model | Input $/1M | Output $/1M | Cache read |
| --- | ---: | ---: | ---: |
| Gemini 2.5 Pro (≤200K ctx) | 1.00 | 10.00 | 0.10 (10% of input) |
| Gemini 2.5 Flash | 0.30 | 2.50 | — |
| Gemini 2.5 Flash-Lite | 0.10 | 0.40 | — |

**Mistral Vibe** — source: `mistral.ai/pricing`. Vibe runs Devstral
models via the Mistral API; the CLI wires them through subscription
tiers.

| Model | Input $/1M | Output $/1M |
| --- | ---: | ---: |
| Devstral 2 (123B) | 0.40 | 2.00 |
| Devstral Small 2 (24B) | 0.10 | 0.30 |

| Plan | Price / month | Notes |
| --- | ---: | --- |
| Mistral Free       | **$0**       | 6 free messages / day, 5 web searches, 30 think mode, 5 deep research, 5 code interpreter |
| Mistral Pro        | **$14.99**   | Vibe for all-day coding (pay-as-you-go beyond), 1000 memories, 15 GB storage |
| Mistral Team       | **$24.99**/user | 30 GB / user, domain verification |
| Mistral Enterprise | **custom**   | Private deployments |

**OpenCode** — source: `opencode.ai`. BYOK-first (bring your own API
keys), no proprietary token rates. Two first-party offerings exist
alongside BYOK:

- **OpenCode Go** — $5–10 / month subscription (beta).
- **OpenCode Zen** — pay-as-you-go API gateway.

Out of scope today: Copilot's seat pricing, Cursor's Pro / Business /
Ultra tiers, Windsurf, Cline + Router combos. Adding them is mostly a
matter of writing the right `config.json` entry and, for tools that
don't share Claude Code's JSONL format, a small adapter in `scanJsonl`.

## Limitations

- **Local JSONL only.** `subfit-ai` reads the files Claude Code writes to
  `~/.claude`. If your usage lives behind an API export, a cloud
  workspace, or another assistant entirely, this tool cannot see it.
- **Baselines, not SLAs.** Subscription caps come from Anthropic's
  documentation and community observations (see the sources cited above).
  Providers adjust them without notice; the verdict reflects the
  documented state at config-refresh time, not a guarantee.
- **No real-time throttling model.** Verdicts compare your *average*
  5-hour volume against the published baseline. They do not model peak
  bursts, weekly caps that Anthropic does not publish numerically, or
  back-off behavior — your actual experience can be worse on spiky days
  (hence the volatility warning and the 20% MARGINAL buffer).
- **API cost vs subscription cost is not apples-to-apples.** The per-model
  table prices your tokens at Claude's public API rates. A subscription
  bundles those tokens for a flat fee with its own rate limits; the two
  numbers answer different questions (what-if-metered vs what-you-pay).
  Use the subscription table for fit, the per-model table for headroom
  analysis.
- **Sessions ≈ JSONL files, not Anthropic's internal notion.** The 50
  sessions / month cap on Claude Max is enforced server-side on
  Anthropic's definition of a session; `subfit-ai` counts one JSONL
  file = one session as a useful proxy, but real throttling can differ if
  Claude Code splits or merges session files.
- **Timestamps drive the window math.** The 5-hour rate assumes 4.8
  windows / day (24 / 5). Days with no activity still count toward the
  date span.

## Contributing

Pull requests, bug reports, and ideas are welcome. Good areas to start:

- **Other providers**: wire Gemini, Codex Mini, OpenCode, Copilot, etc.
  into `config.json` + `default-config.json` with sources cited in
  `_source`.
- **Other session formats**: adapt `scanJsonl()` to read Cursor /
  Windsurf / Cline / Copilot-chat transcripts so users of those tools
  get the same cost breakdown.
- **Better session detection**: replace the "1 JSONL = 1 session" proxy
  with a real windowing algorithm that matches Anthropic's cap.
- **Throttling model**: upgrade the verdict from "avg vs baseline" to a
  peak-aware model using the timestamps already in the data.
- **Tests**: a test suite covers the core functions (run `npm test`).

Keep PRs focused (one change set per PR), update the `_source` fields
when you bump numbers, and rerun `subfit-ai --json` to sanity-check any
config change before committing.

---

Built with [Claude Code](https://claude.ai/code) by Anthropic.

## License

MIT — see [LICENSE](./LICENSE).
