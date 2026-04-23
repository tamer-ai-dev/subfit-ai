# subfit-ai

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](./package.json)
[![Tested with Claude Code](https://img.shields.io/badge/tested%20with-Claude%20Code-8A2BE2.svg)](https://claude.ai/code)

**find the plan that fits your usage.**

## What it does

`subfit-ai` scans your local Claude Code session history, prices the same
token volume on OpenAI Codex, and checks which subscription tier — Claude
Pro / Max 5x / Max 20x / Team / Enterprise, or OpenAI Plus / Pro / Pro 20x —
your real 5-hour usage actually fits into. It runs entirely offline against
the JSONL files Claude Code already writes to disk.

## How it works

**Data source: local JSONL files only.** Claude Code appends one JSON event
per line to `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl` as you chat —
one file per session, kept on your machine. `subfit-ai` reads those files
directly; no Anthropic API export, no network call, no third-party
aggregator. If `claude` has run on this machine, the data is already on
disk and `subfit-ai` can price it.

Every assistant turn carries token counts under `message.usage`:

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

`subfit-ai` walks `~/.claude` recursively, picks every `*.jsonl` at any
depth, keeps only lines where `type === "assistant"` with a
`message.usage` block, sums the four token counts per model and per
YYYY-MM, and computes:

1. **What you actually paid to Anthropic** — at Claude API rates for the
   model that produced each token (Opus / Sonnet / Haiku, with cache-read
   and cache-creation priced separately).
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
npx tsx ./subfit-ai.ts                    # scan ~/.claude with defaults
npx tsx ./subfit-ai.ts --demo             # use bundled examples/sample.jsonl
npx tsx ./subfit-ai.ts --path /custom     # scan another directory
npx tsx ./subfit-ai.ts --config my.json   # custom pricing / plan file
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
| `--path <dir>` | `~/.claude` | Root directory to scan recursively for `*.jsonl` |
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
Scanned 847 JSONL file(s) under ~/.claude
  config: ./config.json
  lines: 54,912  assistant: 12,431  with-usage: 12,431  parse-errors: 0
  date range: 2026-03-22 → 2026-04-22

── Subscription comparison ──
Your usage: 12,431 assistant messages over 30.0 days
  ≈ 414.4 msgs/day  ≈ 86.3 msgs per 5h window

Plan               Price/mo  5h limit   Fits your avg?                                      Note
─────────────────  ────────  ─────────  ──────────────────────────────────────────────────  ────────────────────────────────────
Claude Pro         $20       10-45      EXCEEDS by 1.9x (avg 86.3 > high bound 45)          40-45 observed, shared across products
Claude Max 5x      $100      225+       FITS comfortably (avg 86.3 ≤ baseline 225+)         225+ baseline, 50 sessions/mo cap
Claude Max 20x     $200      900+       FITS comfortably (avg 86.3 ≤ baseline 900+)         900+ baseline, 50 sessions/mo cap
Claude Team        $30       10-45      EXCEEDS by 1.9x (avg 86.3 > high bound 45)          similar to Pro, per seat
Claude Enterprise  custom    unlimited  unlimited — fits                                    custom pricing, unlimited
OpenAI Plus        $20       10-60      EXCEEDS by 1.4x (avg 86.3 > high bound 60)          Codex cloud tasks / 5h
OpenAI Pro         $100      50-300     FITS at high-usage tier (avg 86.3 within [50-300])  Codex cloud tasks / 5h
OpenAI Pro 20x     $200      200-1200   FITS comfortably (avg 86.3 ≤ low bound 200)         Codex cloud tasks / 5h

Sessions: 847 total over 2 month(s) (avg 423.5/mo). Max plans cap at 50 sessions/mo.
  ⚠ EXCEEDS 50 sessions/mo cap on Claude Max plans

⚠ Claude subscription limits are documented baselines, not guarantees. Community
  reports indicate they can deplete faster than expected on some workloads.
  If your avg is within 20% of a plan limit, expect occasional throttling.

→ Best fit: OpenAI Pro at $100/mo — fits within high-usage band

── Per model ──
Model             Msgs   In    Out    CacheR  CacheW   Claude $    Codex-Std $  Codex-Pri $  Ratio
────────────────  ─────  ────  ─────  ──────  ───────  ──────────  ───────────  ───────────  ───────
Claude Opus 4     9,284  842k  4.1M   1.2B    18.4M    $2,842.51   $331.85      $5,432.18    0.12x
Claude Sonnet 4   2,731  245k  1.2M   384M    6.1M     $524.63     $192.47      $1,573.22    0.37x
Claude Haiku 4.5    416   38k  195k   62M     1.2M     $12.87      $28.44       $276.33      2.21x

── Per month ──
Month     Msgs    In    Out    Claude $    Codex-Std $  Ratio
───────   ─────   ────  ─────  ──────────  ───────────  ───────
2026-03   3,217   238k  1.2M   $927.32     $156.14      0.17x
2026-04   9,214   887k  4.3M   $2,452.69   $396.62      0.16x
```

The terminal output leads with the subscription verdict (the question you
came to answer) and the per-model / per-month tables follow as supporting
evidence. Under the comparison table:

- **Sessions line**: total distinct JSONL files (≈ Claude sessions) seen,
  the months they span, and the resulting `avg N/mo`. If the average
  exceeds 50, Claude Max plans will hit the session cap even when their
  5h verdict says FITS — this is why the example above recommends OpenAI
  Pro (which has no session cap) rather than Claude Max 20x.
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
    "claude-opus-4":    { "label": "Claude Opus 4", "input": 15.0, "output": 75.0, "cacheRead": 1.5, "cacheWrite": 18.75 },
    "claude-sonnet-4":  { "label": "Claude Sonnet 4", "input": 3.0, "output": 15.0, "cacheRead": 0.3, "cacheWrite": 3.75 },
    "claude-haiku-4-5": { "label": "Claude Haiku 4.5", "input": 0.80, "output": 4.0, "cacheRead": 0.08, "cacheWrite": 1.0 },
    "codex-standard":   { "label": "OpenAI Codex (gpt-5.3-codex) standard", "input": 1.75, "cacheRead": 0.175, "cacheWrite": 0, "output": 14.0 },
    "codex-priority":   { "label": "OpenAI Codex (gpt-5.3-codex) priority", "input": 3.50, "cacheWrite": 0, "output": 28.0 }
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

**Ratio column**: `Codex-Std $` divided by the Claude cost on the same
tokens. It is a **cost ratio, not a savings percentage** — `0.12x` means
Claude cost you 8× what Codex would have cost on that volume, not "12%
savings". Read it as:

- `<1.0` → Codex would have been cheaper on that volume
- `>1.0` → Claude was the cheaper provider

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
Give me the current pricing for:
1. Claude API models (Opus, Sonnet, Haiku) — input, output, cache read, cache write rates per 1M tokens
2. OpenAI Codex (latest model) — standard and priority tiers, input, output, cache read rates per 1M tokens
3. Subscription plans: Claude Pro, Claude Max 5x, Claude Max 20x, Claude Team, Claude Enterprise — monthly price, messages per 5h window (use [min, null] for baseline-only limits like Max), session caps
4. OpenAI Plus, Pro, Pro 20x — monthly price, messages per 5h window

Format the result as a JSON matching this structure:
{
  "pricing": { "<model-key>": { "label": "...", "input": N, "output": N, "cacheRead": N, "cacheWrite": N } },
  "planLimits": { "<plan-key>": { "label": "...", "monthlyUsd": N|null, "messagesPer5h": [lo,hi]|[lo,null]|null, "sessionsCap": N|null, "note": "..." } }
}
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

## Comparison landscape

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
