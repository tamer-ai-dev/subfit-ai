# CLAUDE.md

Guidance for Claude Code (or any AI coding agent) working in this
repository. Meta-ironic but useful: a tool that reads Claude Code's JSONL
output deserves its own contributor-facing rules.

## What this project is

`subfit-ai` is a ~1000-line TypeScript CLI that scans
`~/.claude/**/*.jsonl`, prices the tokens against Claude API and OpenAI
Codex rates, and recommends a subscription tier. Zero runtime
dependencies — Node stdlib plus `tsx` to run TypeScript directly.

## Project layout

```
subfit-ai.ts          Single-file CLI. All logic lives here.
config.json           User-editable pricing + plan limits.
default-config.json   Embedded fallback; stays byte-identical with config.json.
examples/sample.jsonl Synthetic fixture used by --demo.
tests/core.test.ts    Vitest unit tests for normalizeModel, verdict5h, etc.
tsconfig.json         Strict typecheck config (noEmit).
package.json          Bin entry, scripts, devDeps.
```

## Golden-path commands

```bash
npm install            # one-time: installs vitest, tsx, typescript, @types/node
npm test               # run vitest
npm run typecheck      # tsc --noEmit against the whole project
npx tsx ./subfit-ai.ts --demo   # exercise end-to-end against sample.jsonl
```

Before opening a PR, run `npm test` AND `npm run typecheck`. Both must
pass.

## Rules for changes

1. **Cite your sources.** Anytime you touch a number in `config.json` or
   `default-config.json` (pricing, plan caps, session caps), add or
   update the `_source` field to a URL that demonstrates the figure.
   Numbers without provenance get rejected.
2. **Keep the two configs byte-identical.** `config.json` is the
   user-edited copy; `default-config.json` is the fallback embedded at
   load time. They must match. A CI diff check is a valid follow-up PR.
3. **Add tests.** New exported functions get ≥3 vitest cases in
   `tests/core.test.ts`. Document-only changes and config bumps are the
   only tests-exempt categories.
4. **Update the example output in README.md** if you change the shape of
   the terminal rendering. The fictional numbers in the example MUST be
   internally consistent (run the numbers through the best-fit logic
   mentally before committing).
5. **No network calls.** This tool is offline by design — no HTTP, no
   API calls, no telemetry. PRs that add external I/O get closed.
6. **One concern per PR.** Pricing bumps, code changes, and docs each
   land separately when possible.
7. **Honour the 20% buffer.** Any change to `verdict5h` / `findBestFit`
   must preserve the semantic: MARGINAL plans are not eligible as
   `primary`. The buffer is policy, not a knob to tune.

## Non-goals

- Real-time throttling estimation (out of scope — see Limitations).
- Reading API logs or provider dashboards (local JSONL only).
- Cost forecasting / predictions — this tool prices what already
  happened.

## When in doubt

Read the `## Limitations` section of `README.md` before extending
scope. Most "obvious" features are intentionally absent.
