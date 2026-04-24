# Claude pricing & rate limits — what `subfit-ai` measures and why

`subfit-ai`'s subscription verdict and 5h-window downgrade simulation
are built on a specific interpretation of how Anthropic bills Claude
plans. This page pins down that interpretation so the output is
reproducible and contestable.

## Plan tiers

All figures below are per-user, per-month unless noted. Non-Enterprise
tiers are pre-tax USD.

| Plan | Price | Published 5h message band | Sessions/month cap |
|---|---|---|---|
| Claude Pro | $20 | 10-45 | — |
| Claude Team | $30/seat | 10-45 | — |
| Claude Max 5x | $100 | 225+ (open-ended) | 50 |
| Claude Max 20x | $200 | 900+ (open-ended) | 50 |
| Claude Enterprise | custom | unlimited (rate-limited) | — |

The "band" notation follows `config.json`:
- `[lo, hi]` — Anthropic publishes both bounds (Pro, Team).
- `[lo, null]` — Anthropic publishes a baseline floor only (Max
  tiers). Actual ceiling is unpublished; `subfit-ai`'s simulation
  compares against the published floor.

Sources:
- [Anthropic support: Claude Max usage](https://support.claude.com/en/articles/11014257)
- [Anthropic support: usage and length limits](https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work)

## The 5-hour rolling window

Anthropic's rate limit operates on a **rolling 5-hour window**:

1. Your first request after an idle period opens a window.
2. All requests for the next 5 hours count against that window's
   message cap.
3. The window closes 5 hours after it opened. The next request after
   that opens a fresh window.

`subfit-ai` models this as **reset-on-expiry** bucketing: events inside
the 5-hour span roll into one window; the first event after expiry
opens the next window. Idle periods produce no windows at all — they
do not dilute usage the way a naïve "divide by 4.8 windows per day"
average would.

See `compute5hWindows` in `subfit-ai.ts` for the implementation.

## What counts as a "message"?

This is the question where a lot of confusion lives. Claude Code's
on-disk JSONL is noisy: a **single API call** to Anthropic produces
**multiple `type=assistant` JSONL lines** — one per streamed content
block (thinking block, each `tool_use` block, each `text` block). A
naïve scan that counts lines would over-count rate-limit impact by
~1.5-1.8× on tool-use-heavy workloads.

`subfit-ai` reconciles the two by tracking both numbers on each window:

| Field | What it counts | Use for |
|---|---|---|
| `eventCount` | Every priced `type=assistant` line | Diagnostics only |
| `messageCount` | Distinct `requestId` values in the window | Rate-limit comparison |

The plan simulation compares `messageCount` against the plan's
`messagesPer5h` cap, because Anthropic's rate limit fires per API
call, not per streamed content block.

### Why requestId is the right key

Claude Code's JSONL lines include a top-level `requestId` field set to
the Anthropic API's request id. All content blocks streamed back from
one `/v1/messages` call share the same `requestId`. That is precisely
the granularity Anthropic's rate limiter uses. We confirmed empirically
on a 130,276-line corpus: 1,556 files, 358,290 total JSONL lines,
130,276 `type=assistant` lines, 74,892 distinct requestIds — so the
per-line count was running ~1.74× high before the fix.

### Non-Claude providers

Gemini, Mistral Vibe, OpenAI Codex, and OpenCode sessions do not emit
an Anthropic-style `requestId`. For their events, `messageCount` falls
back to `1 per event`. That matches how those providers' own rate
limits work (per request, no streaming fan-out).

## What `subfit-ai` does NOT count toward the rate limit

- **Cache-read tokens.** Cache hits are cheap reads, not new requests.
  They show up in the token total but never inflate `messageCount`.
- **Tool-result "user" lines.** When Claude Code runs a tool and feeds
  the output back, it writes a synthetic `type=user` JSONL line with a
  `tool_result` block. Those are part of the next API call's *input*,
  not a separate request. The scanner only increments on
  `type=assistant` lines that carry a `usage` block.
- **System prompts, `file-history-snapshot`, `permission-mode`, and
  other CLI-internal lines.** None of these represent requests to
  Anthropic; all are skipped.

## The downgrade simulation

With the above definitions, `subfit-ai` prints a
`── 5h-window downgrade simulation (message-based) ──` section
alongside the standard subscription verdict. It walks every active 5h
window in the scan and counts, per plan:

- How many windows' `messageCount` exceeded the plan's effective cap
  (hi bound for `[lo, hi]` bands; lo bound for `[lo, null]`
  baselines).
- The resulting hit percentage.
- A verdict badge using these thresholds:
  - **≤2%** → `smooth` (rare throttling, safe to downgrade)
  - **≤10%** → `workable` (occasional throttling, tolerable)
  - **≤50%** → `painful` (frequent throttling)
  - **>50%** → `unusable` (majority of active windows hit the cap)

The question the simulation answers is concrete: *"If I downgraded to
plan X, how many of the 5-hour windows I actually used would have
blocked on the cap?"*

### What it does NOT tell you

- **Weekly caps.** As of August 2025, Anthropic added overall weekly
  Sonnet/Opus hour caps that are separate from the 5h message cap.
  They are not modelled here.
- **Peak-hour throttling.** Anthropic applies dynamic throttling during
  weekday peak hours (5-11am PT) that makes the 5h budget drain
  faster. We compare against the documented cap only.
- **Token budgets.** Some community sources report community-estimated
  token-per-5h figures. Those are not published by Anthropic and we do
  not model them. (We tried briefly; the token caps we found were
  speculative and produced misleading results.)

## Cross-plan comparisons: Copilot vs. Claude

The downgrade / monthly-sim tables include GitHub Copilot tiers for
completeness, but **Copilot's "premium request" unit is not 1:1
comparable to a Claude assistant message**:

- A single Copilot premium request can cost anywhere from **1×** (a
  small GPT-4.1 call) to **20×** (a Claude Opus call routed via
  Copilot). Anthropic's own message accounting is closer to 1:1 per
  API call.
- Copilot Free's "2,000 completions/month" is **inline autocomplete**,
  not chat/agent requests. `subfit-ai` does NOT count those as
  premium requests or Claude messages — the monthly sim uses the
  **premium-request** quota only.
- `messagesPer5h` is `null` for Copilot plans because GitHub does not
  throttle per 5-hour window; the constraint is entirely monthly.

The simulation therefore reports a rough floor for Copilot, not an
apples-to-apples number. Treat Copilot rows as a sanity check ("would
I instantly blow past the premium-request budget?"), not as a precise
cost model.

### Best-fit recommender

`findBestFit` considers both the 5h verdict AND the monthly
simulation. A plan whose monthly hit rate is `painful` (>10%) or
`unusable` (>50%) is disqualified from the "comfortable" pool, even
when its 5h verdict says "unlimited". This is why Copilot Free
(messagesPer5h: null, unlimited 5h → looked like a free fit) stopped
appearing as a recommendation once the monthly cap check was added.

## Updating the plan data

Published 5h bands live in `planLimits` in `config.json`. When
Anthropic updates their docs, edit the `[lo, hi]` or `[lo, null]`
tuple, update the `_source` URL, and keep `config.json` and
`default-config.json` byte-identical (CLAUDE.md rule #2).

The `tokensPer5h` field is **not** supported — we removed it after
finding the community estimates were unreliable and were modelling the
wrong quantity (rate limits are per-request, not per-token). Do not
add it back without authoritative data.
