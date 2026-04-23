# Study: GitHub Copilot CLI Token Storage & Subfit-ai Adapter

This document analyzes how **GitHub Copilot CLI** persists session /
token data locally, to inform a potential `subfit-ai` adapter.
Copilot was not installed on the authoring machine and the account
used for research did not carry an active Copilot subscription, so
most of this is compiled from public documentation. Sections marked
**[UNVERIFIED]** need a contributor with an active subscription to
confirm.

**Primary references**:

- `https://github.com/features/copilot`
- `https://docs.github.com/copilot`
- `gh copilot` / `gh copilot-cli` subcommand help (requires a logged-in
  `gh` CLI and an active Copilot seat).

## 1. What "Copilot CLI" actually is

Copilot CLI (current public version: v1.0.5) is the terminal entry
point that ships as a `gh` extension. Installation + authentication
flow:

```bash
gh auth login                       # GitHub OAuth
gh extension install github/gh-copilot
gh copilot --help
```

There is no separate API key provisioning; authentication is
delegated to `gh auth`. Access is **gated on an active Copilot
subscription** on the GitHub account logged into `gh`.

## 2. Subscription Tiers (the subfit-ai mismatch)

Copilot is sold **per seat**, not per token. As of the current
pricing page:

| Plan | Price / seat / month |
| --- | ---: |
| Copilot Individual   | $10 |
| Copilot Business     | $19 |
| Copilot Enterprise   | $39 |

These are flat monthly fees with **no published per-token API
rate**. Copilot's API for completions and chat is not exposed for
metered billing to individual developers — it is consumed through
IDE plugins and the `gh copilot` CLI, all of which run under the
seat entitlement.

This is the structural mismatch with `subfit-ai`: the tool's cost
model is "price the tokens against each provider's API rate and
see which subscription tier fits". For Copilot there is no API
rate to multiply against, and the subscription *is* the whole
product — there is no "metered overflow" to compare with. Any
adapter would have to either:

1. **Skip pricing** and only report usage volume (useful for seeing
   whether Copilot is actually pulling its weight), or
2. **Invent a reference rate** from a peer provider (e.g., treat
   Copilot tokens as if billed at `claude-sonnet-4` rates) to give
   a comparable dollar figure. Note in the output that this is a
   synthetic benchmark, not an invoice.

Neither maps cleanly to the existing `ScanContext` → `computeRows`
→ `Provider $ / Codex-Std $ / Ratio` pipeline.

## 3. Local Token Storage — **[UNVERIFIED]**

Public documentation does **not** describe any local persistence of
per-turn token counts for Copilot CLI. Observable on-disk artefacts
on a logged-in machine:

```
~/.config/gh/                    # gh auth state, host config
~/.config/gh/hosts.yml           # OAuth tokens for github.com
~/.cache/gh-copilot/             # [UNVERIFIED] — may or may not exist
```

Absence of a documented session log is not proof of absence, but
unlike Claude Code, Gemini CLI, and (to a lesser extent) Codex CLI,
the GitHub docs do not expose a "where transcripts live" section.
Working assumptions until a contributor verifies:

- **[UNVERIFIED]** Copilot CLI may not persist token counts locally
  at all. The server holds the usage; the client is stateless
  beyond the OAuth token.
- **[UNVERIFIED]** If any local log exists, it is likely under
  `~/.cache/gh-copilot/` or inside the `gh` extension cache, not
  under `~/.copilot/`.
- **[UNVERIFIED]** The `gh api user/settings/billing/usage`-style
  endpoints may expose Copilot usage via the GitHub REST API, but
  that is a **network** read, not a local-file read. `subfit-ai` is
  offline by design, so an API-based adapter would have to be a
  separate opt-in command.

## 4. Comparison with Claude Code, Gemini CLI, Codex CLI, and Vibe

| Feature | Claude Code | Gemini CLI | Codex CLI | Vibe CLI | Copilot CLI |
| --- | --- | --- | --- | --- | --- |
| Billing model | API / seat | API / seat | API / seat | API (free for now) | **seat only** |
| Per-token price | yes | yes | yes | yes | **no public rate** |
| Storage root | `~/.claude/` | `~/.gemini/` | `~/.codex/` | `~/.vibe/` | `~/.config/gh/` (auth) |
| Session file format | JSONL | JSON | [UNVERIFIED] | [UNVERIFIED] | **[UNVERIFIED] / may not exist** |
| Usage block in files | yes (`message.usage`) | yes (`tokens`) | assumed (`response.usage`) | assumed (`usage`) | **unknown** |
| Offline cost priceable | yes | yes | yes | yes | **no (seat flat fee)** |

## 5. Proposed Adapter for subfit-ai — **mostly negative**

A Copilot adapter is a bad fit for the current `subfit-ai` model.
A contributor who insists on adding one should pick one of:

1. **Usage-only mode** — scan whatever local log Copilot exposes
   (if anything), surface a row labelled "Copilot: N turns / day"
   in the summary, and leave the `Provider $` / `Ratio` columns
   blank. This tells the user whether they are over- or under-using
   the seat, without pretending to price it.
2. **Synthetic benchmark mode** — invent a "what if these turns had
   been billed at Claude Sonnet rates" line, clearly labelled
   `(synthetic, not an invoice)`. Useful as a sanity check on seat
   ROI.
3. **Skip entirely** — document Copilot in the comparison landscape
   as "seat-priced, out of scope for subfit-ai's token-pricing
   model", and do not ship an adapter.

The README's `## Comparison landscape` section already notes Copilot
under "Out of scope today". Option 3 is the honest default until
someone with a Copilot seat confirms that a token log even exists
locally.

## 6. Open Questions (to resolve before any implementation)

- **[UNVERIFIED]** Does Copilot CLI write any per-turn token log to
  disk at all? If so, where?
- **[UNVERIFIED]** Does the `github.com/features/copilot-metrics`
  API endpoint (seen in product docs for admins) expose individual
  developer token counts, or only aggregate org usage?
- **[UNVERIFIED]** If a local log exists, is it in a format
  `subfit-ai` could parse with a small adapter, or is it a binary
  cache / database?
- **[UNVERIFIED]** Does Copilot Business / Enterprise expose a more
  granular API (seat → tokens) that would let an org admin price
  actual consumption?

## 7. Conclusion

Copilot does not cleanly fit `subfit-ai`'s model: there is no
public per-token rate and no documented local token log. The
safest default is **not** to ship a Copilot adapter in the current
architecture, and to document Copilot in the comparison landscape
as a seat-priced product that the tool deliberately does not price.
If a contributor confirms the existence of a local token log, a
"usage-only" (no `$`) row could be added with clear labelling
that the seat fee is the entire bill.
