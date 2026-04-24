# How to read the subfit-ai report

`subfit-ai` prints a handful of sections stacked top-to-bottom. Each
answers a different question and uses a slightly different accounting
convention — a single "message" can mean three different things
depending on which table you're looking at. This guide walks the
output top-to-bottom so the numbers stop surprising you.

If you want the underlying semantics (how the 5h window is modelled,
what an event is), see [`claude-pricing.md`](./claude-pricing.md) —
this page is the field guide, that one is the spec.

---

## 1. Scan summary

```
── Scan summary ──
Provider  Files  Entries  Messages  With tokens  Parse-errors  Date range
────────  ─────  ───────  ────────  ───────────  ────────────  ───────────────────────
Claude    1,556  359,145  130,568   130,568      3             2026-01-20 → 2026-04-24
Gemini    48     1,172    975       974          0             2026-03-08 → 2026-04-23
...
Tokens: 47.69M input, 32.57M output, 27.18B cache-read, 540.54M cache-write
```

### Columns

- **Files** — number of session files scanned for that provider. Each
  file is usually one session (Claude: one per `~/.claude` conversation;
  Gemini/Vibe/Codex/OpenCode: one per session JSON).
- **Entries** — every parseable record in those files. For Claude JSONL
  this counts *every* line (system, user, assistant, tool, permission,
  etc.). Most entries are not billable.
- **Messages** — entries that look like assistant turns (the model
  producing output). This is where tokens live.
- **With tokens** — messages that carry a `usage` block. Messages
  without usage (rare — aborted turns, tool-only events) don't get
  priced and don't show up in rate-limit counts.
- **Parse-errors** — lines we couldn't JSON-parse. Almost always zero;
  more than a handful suggests a corrupted session file.

### Why "Messages" ≠ "Entries"

On Claude Code, **each assistant API response is streamed as multiple
JSONL lines** — typically one per content block (thinking, tool_use,
text). A single API call with `thinking + tool_use + text` writes
three `type=assistant` lines that all share the same `requestId`.

So:
- **Entries**: raw JSONL line count (inflated).
- **Messages**: `type=assistant` lines specifically.
- **API calls**: distinct `requestId` values — what the 5h and monthly
  simulations actually count. Not in this header, but it's what
  "messageCount" means downstream.

One API call ≈ 1.5–1.8 assistant JSONL lines in practice, depending on
how tool-heavy the session is.

### Token breakdown

- **input** — prompt tokens you sent (the "new" part of each request).
- **output** — what the model returned.
- **cache-read** — prompt tokens that were served from Anthropic's
  prompt cache instead of re-processed. Billed at a heavy discount
  (~10% of input rate). On Claude Code this number is **huge** (tens
  of billions) because every turn re-sends the conversation so far,
  and the cache absorbs most of it.
- **cache-write** — tokens written *into* the cache at the start of a
  cached segment. Billed at ~1.25× input. Order-of-magnitude smaller
  than cache-read.

Cache tokens are about dollars, not rate limits. They don't count
toward the 5h message cap.

---

## 2. Subscription comparison

```
Your usage: 131,542 assistant messages over 93.7 days
  ≈ 1403.3 msgs/day  ≈ 292.3 msgs per 5h window

Plan                Price/mo  5h limit  Fits your avg?                               Note
Claude Pro          $20       10-45     EXCEEDS by 6.5x (avg 292.3 > high bound 45)  40-45 observed, ...
Claude Max 20x      $200      900+      FITS comfortably (avg 292.3 ≤ baseline 900+) 900+ baseline, 50 sessions/mo cap, ...
```

### What "5h limit" means

Anthropic rate-limits on a **rolling 5-hour window**: the clock starts
on your first message after an idle period, and all requests for the
next 5h count against the plan's cap. The limit is in "messages",
which means **API calls** for Claude Code usage.

Format in the table:
- **`10-45`** — fixed band published by Anthropic (Pro). Low end for
  heavy prompts, high end for light ones.
- **`225+`** — open-ended baseline (Max tiers). Anthropic publishes
  only the floor; the real ceiling is unpublished.
- **`unlimited`** — no 5h throttling (Enterprise, Mistral Pro, Copilot).

### Why "Fits your avg?" is misleading

The average `292.3 msgs / 5h window` is `total messages ÷ (days × 4.8)`.
This is a **flat amortisation** — it assumes you're sending messages
24 hours a day, seven days a week, including when you sleep.

In reality you're active maybe 8–12 hours a day. During that active
window your real throughput is 2–3× the flat average. So:

- The subscription-comparison verdict (`FITS comfortably`,
  `EXCEEDS by 6.5x`, etc.) is a **coarse first check**, useful for
  eliminating plans that don't have a chance.
- The **5h-window downgrade simulation** below it is what you should
  actually trust — it counts real, contiguous 5h bursts.

### The "Note" column

Plain English caveats per plan, e.g.:

- `40-45 observed, shared across claude.ai + Code + Desktop` — the Pro
  cap is shared across all Claude surfaces.
- `225+ baseline, 50 sessions/mo cap, weekly limit unpublished` — Max
  plans have two orthogonal limits (5h message cap AND monthly session
  count) plus a weekly hours cap that isn't published.
- `Vibe for all-day coding (pay-as-you-go beyond)` — Mistral Pro has
  no 5h throttle but bills you once you cross internal caps.

### Session count warning

```
Sessions: 1,607 total over 4 month(s) (avg 401.8/mo). Max plans cap at 50 sessions/mo.
  ⚠ EXCEEDS 50 sessions/mo cap on Claude Max plans
```

`Session` ≈ one distinct JSONL file. Anthropic's Max plans have a
50-sessions-per-month cap separate from the 5h message cap. Restart
Claude Code often and you'll trip this even at low message volumes.

### "Best fit"

```
→ Best fit: Mistral Pro at $15/mo — unlimited 5h throughput
```

Picks the **cheapest plan that is**:

1. Not exceeding its 5h cap (at your flat average).
2. Not marginal (within 20% of the cap).
3. Not blocked by a session cap (avg sessions/mo > plan cap).
4. Not blocked by the monthly-quota simulation (more on that below).

Limitations:
- It uses the flat average, not the 5h-window distribution. A plan
  that "fits your average" can still be painful in real burst
  patterns — the simulation table catches that.
- It picks on price alone within the "comfortable" bucket. It does not
  weigh vendor lock-in, model quality, context-window differences,
  team features, or anything else.
- Cross-product substitutions ("switch from Claude to Mistral") require
  workflow change you may not want.

---

## 3. 5h-window downgrade simulation

```
── 5h-window downgrade simulation (message-based) ──
222 active 5h windows analyzed over 94 days
Avg messages per window: 325 / Peak: 1,948

Plan            Price/mo  Msg cap (5h)  Windows over cap  Hit %  Verdict
Claude Pro      $20       45            170 / 222         76.6%  unusable
Claude Max 5x   $100      225            96 / 222         43.2%  painful
Claude Max 20x  $200      900            18 / 222          8.1%  workable
```

The big one. This answers: *"If I downgraded to plan X, how often
would I actually hit the cap during real work?"*

### What "active windows" means

`subfit-ai` uses **reset-on-expiry** bucketing, which mirrors how
Anthropic's rate limiter works:

1. Your first message opens a window.
2. Every message in the next 5 hours rolls into that window.
3. After 5h the window closes. The next message (whenever it arrives)
   opens a fresh window.

So `222 active windows over 94 days` means there were 222 distinct
~5-hour bursts of activity. Sleep, weekends, and idle periods don't
produce windows — they don't dilute your burst rate.

### What counts as a "message" here

**Distinct `requestId` values per window** — i.e. API calls. If a
single API call streams back 3 content blocks (3 JSONL lines sharing
one requestId), that's 1 message, not 3.

For non-Claude providers (Gemini/Vibe/Codex/OpenCode) there's no
`requestId`, so each event counts as 1 message. Those providers don't
stream content blocks the same way so the counts are already clean.

### Why cache-reads don't count

The rate limit counts **requests**, not tokens. A request can carry
zero, one, or a billion cache-read tokens — it still counts as one
request. That's why this tool stopped tracking tokens when modelling
rate limits.

### Verdicts

| Hit %       | Verdict    | Rough read                                          |
|-------------|------------|-----------------------------------------------------|
| 0 – 2       | `smooth`   | You'd basically never notice throttling.            |
| 2 – 10      | `workable` | Occasional bumps, but you can live with them.       |
| 10 – 50     | `painful`  | Hitting the cap in a meaningful share of sessions.  |
| > 50        | `unusable` | More active windows would throttle than wouldn't.   |

These thresholds are chosen for the downgrade question, not for
SLAs. 8% "workable" is not a promise — it means roughly 1 in 12
active windows hit the cap, which most people tolerate. 22%
"painful" is the kind of number people complain about loudly.

### Reading "Windows over cap" and "Hit %"

`170 / 222` = 170 of the 222 active windows had more requests than
the plan's 5h cap allows. The percentage is the same number in a
different form. Sort the rows by price ascending and scan down the
Verdict column to find where "painful" turns into "workable" — that's
where you'd stop feeling throttled.

---

## 4. Monthly quota simulation

```
── Monthly quota simulation ──
4 month(s) analyzed (2026-01 to 2026-04)
Avg messages per month: 18,054 / Peak: 40,842

Plan                       Price/mo  Monthly cap        Months over cap  Hit %   Verdict
GitHub Copilot Free        $0        50 premium req     4 / 4            100.0%  unusable
GitHub Copilot Pro         $10       300 premium req    3 / 4             75.0%  unusable
GitHub Copilot Pro+        $39       1,500 premium req  3 / 4             75.0%  unusable
GitHub Copilot Enterprise  $60       1,000 premium req  3 / 4             75.0%  unusable

⚠ Copilot "premium requests" ≠ Claude "messages"...
⚠ Copilot's 2,000 completions/month (Free tier) are inline autocomplete...
```

### Why this section exists

Some products (GitHub Copilot in particular) don't have a 5h cap at
all — they meter on a **monthly quota** instead. A plan that looks
"unlimited" in the subscription table can still fail every month on
its monthly cap. This table catches that.

### "premium req" vs "msgs"

The unit in the `Monthly cap` column tells you what the plan actually
meters:

- **`msgs`** — plain message count, directly comparable to Claude
  assistant turns (dedup'd by `requestId`).
- **`premium req`** — Copilot's "premium request" unit. Copilot routes
  a request to one of many models, and each costs a different number
  of premium requests (GPT-4.1 ≈ 1×, Claude Opus routed via Copilot ≈
  20×). So the Copilot `Hit %` is a rough floor, not a precise
  comparison.

Both disclaimers print every time a non-default unit shows up:

- Copilot premium requests aren't 1:1 with Claude messages.
- Copilot Free's headline "2,000 completions/month" is inline
  autocomplete (ghost-text in your editor), not chat/agent
  requests. The simulation does NOT count those.

If every plan in this table says `unusable`, you're in the territory
where the Copilot family doesn't fit — regardless of tier.

---

## 5. Per model / Per month tables

```
── Per model ──
Model             Msgs    In      Out     CacheR  CacheW   Provider $  Codex-Std $  Codex-Pri $  Ratio
Claude Opus 4     106714  2.06M   29.98M  26.10B  416.06M  $16411.42   $4991.25     $92205.13    0.30x
...

── Per month ──
Month    Msgs    In      Out     CacheR   CacheW   Provider $  Codex-Std $  Ratio
2026-03  47415   37.83M  7.93M   8.64B    213.43M  $5363.47    $1689.31     0.31x
```

### What the dollar columns mean

**None of these are what you actually paid.** They are hypothetical
API-pricing costs using the provider's public per-token rates. If you
were pay-as-you-go (no subscription), this is roughly what the same
token volume would have cost:

- **Provider $** — priced on the native provider's published rates
  (Claude on Anthropic pricing, Gemini on Google pricing, etc.).
- **Codex-Std $** — the same tokens repriced on OpenAI's Codex /
  GPT-5 Standard rates.
- **Codex-Pri $** — repriced on Codex Priority rates (higher-cost,
  guaranteed-capacity tier).

### Ratio column

`Codex-Std ÷ Provider`. So:

- **< 1.0** — running the same tokens through Codex Standard would be
  *cheaper* than running them natively. Anthropic's Opus 4 at
  $5/$25 per million is expensive relative to Codex's $1.75/$14.
  Gemini Flash at $0.30/$2.50 is very cheap on its own, so Codex
  looks expensive against it (ratio > 1).
- **> 1.0** — native provider is cheaper, Codex would cost more.

Use this to figure out whether a model swap would save you money on
pure token economics, setting aside capability differences.

### Per month

Same shape as Per model, grouped by calendar month. Useful for seeing
when the heavy usage happened — a ramp from ~$3 in January 2026 to
~$11,000 in April 2026 tells a clear story.

---

## 6. Common questions

**Q: Why does it say I use 130,000 messages? That can't be right.**

Each API call counts as one message. Claude Code does tool loops —
"read file", "search for X", "edit Y" — and each one is a separate
API call to Claude. A single user prompt can easily produce 10–20
API calls. Over 94 days of active use, 130k is a plausible number
even for one person.

**Q: Why is cache-read 27 *billion* tokens?**

Claude Code prepends the whole conversation to every API call. When
the conversation is long (and tool-use-heavy sessions get long
fast), Anthropic's prompt cache absorbs the unchanged prefix and
the tokens show up as cache reads. They're billed at ~10% of the
normal input rate so the dollar impact is smaller than the count
suggests.

**Q: Is the "Provider $" what I actually paid?**

No. Subscriptions (Claude Pro / Max, Copilot Pro) charge a flat
fee regardless of usage. The dollar columns are **what pay-as-you-go
API usage would have cost** for the same token volume. Use them to
compare plans against one another, not to audit your credit card
statement.

**Q: What should I do with this report?**

Three practical uses, in order:

1. **Verify your current plan fits.** Find your current plan in the
   5h downgrade simulation. If it says `workable` or `smooth` you're
   fine. If it says `painful` or `unusable` you're either
   overpaying for the wrong tier or quietly getting throttled.

2. **Check if a downgrade is viable.** Scan upward from your plan in
   the simulation. The first plan with `workable` or better is
   the cheapest you can credibly downgrade to.

3. **Sanity-check upstream costs.** The Per-model table tells you
   which model is driving spend. If 95% of the bill is Opus, swapping
   routine work to Haiku or Sonnet may cut the bill substantially
   without losing capability on the parts that actually need Opus.

---

## See also

- [`claude-pricing.md`](./claude-pricing.md) — the semantics behind the
  numbers (5h window model, requestId dedup, plan tiers, caveats).
- [README.md](../README.md#how-it-works) — where the data comes from.
