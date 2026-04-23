# Contributing to subfit-ai

Pull requests, bug reports, and ideas are welcome. This document collects
the rules so you don't have to dig through the README to figure out what a
good PR looks like.

## Getting started

```bash
git clone <repo>
cd subfit-ai
npm install                            # vitest, tsx, typescript, @types/node
npm test                               # vitest — must pass
npm run typecheck                      # tsc --noEmit — must pass
npx tsx ./subfit-ai.ts --demo          # end-to-end smoke against examples/sample.jsonl
```

All commands are zero-install for users (the CLI itself needs only `tsx`
via npx). The dev dependencies above are only for the test / typecheck
loop.

## Areas we want PRs for

- **Other providers** — wire Gemini, OpenAI Codex Mini, OpenCode, GitHub
  Copilot, Cursor, etc. into `config.json` + `default-config.json` with a
  sourced `_source` URL per entry.
- **Other session formats** — adapt `scanJsonl()` / `findJsonlFiles()` to
  read Cursor / Windsurf / Cline / Copilot Chat transcripts so users of
  those tools get a matching cost breakdown. Keep each adapter small and
  testable.
- **Better session detection** — replace the "1 JSONL file = 1 session"
  proxy with a real windowing algorithm that matches Anthropic's own
  session definition.
- **Throttling model** — upgrade the `verdict5h` heuristic from
  "avg vs baseline" to a peak-aware model using the timestamps already
  captured in `ScanContext`.
- **More tests** — the existing suite covers the core functions; adapters
  and rendering paths are still thin.

## Rules for every PR

1. **Cite sources.** Any number change in `config.json` /
   `default-config.json` (pricing, plan caps, session caps) must update
   or add the `_source` field with a URL that demonstrates the figure.
   Undocumented numbers are rejected.
2. **Configs stay byte-identical.** `config.json` (user-editable) and
   `default-config.json` (embedded fallback) must match. Update both or
   neither.
3. **Tests pass.** `npm test` and `npm run typecheck` both green. New
   exported functions need ≥3 vitest cases in `tests/core.test.ts`.
4. **No network calls.** `subfit-ai` is offline by design — no HTTP, no
   API calls, no telemetry. PRs that add outbound I/O will be closed.
5. **One concern per PR.** Pricing bumps, code changes, and docs land
   separately when possible.
6. **Update README example output** if you change the shape of terminal
   rendering — and keep the fictional numbers internally consistent
   (the example must still pass the best-fit logic).
7. **Honour the 20% buffer.** `verdict5h` / `findBestFit` must continue
   to exclude MARGINAL plans from `primary`. The buffer is policy.

## Commit style

- Imperative mood, short subject (`fix:`, `feat:`, `docs:`, `test:`,
  `ci:`, `chore:`).
- Scope in parens when useful: `feat(subfit-ai): ...`.
- Body explains the why when the subject can't; skip it for trivial
  changes.

## Reporting issues

Open a GitHub issue with:

- `subfit-ai --version` (coming soon) or the commit SHA you're on.
- The command you ran and the error / unexpected output.
- For mispricing: paste the relevant JSONL line (redact if needed) and
  the exact `config.json` entries involved.

Please **never** include real session content unless you've reviewed it
for sensitive data. Token counts + model name + timestamp are enough for
almost every bug report.
