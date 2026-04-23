# AGENT.md

Instructions for AI agents contributing to subfit-ai.

## Project Structure

```
subfit-ai/          # Single-file CLI (~1067 lines)
├── subfit-ai.ts     # Main entry point
├── config.json      # User-editable pricing + plan limits
├── default-config.json   # Embedded fallback (must be byte-identical to config.json)
├── examples/sample.jsonl  # Synthetic fixture for --demo
├── tests/core.test.ts    # Vitest unit tests
├── package.json     # Bin entry, devDeps
└── tsconfig.json   # Strict typecheck (noEmit)
```

## Commands

```bash
npm install            # Install devDeps (vitest, tsx, typescript)
npm test              # Run vitest
npm run typecheck    # tsc --noEmit
npx tsx ./subfit-ai.ts --demo   # Exercise end-to-end
```

## Contribution Rules

1. **Cite sources for numbers.** Any change to `config.json` or `default-config.json` (pricing, plan caps) must add/update `_source` field to a URL. Numbers without provenance are rejected.

2. **Keep configs byte-identical.** `config.json` is user-edited; `default-config.json` is fallback. They must match exactly.

3. **Add tests.** New exported functions require ≥3 vitest cases in `tests/core.test.ts`. (Doc-only and config bumps are test-exempt.)

4. **Update README example on output changes.** Ensure fictional numbers are internally consistent.

5. **Honour the 20% buffer.** MARGINAL plans (≥80% of limit) are NOT eligible as `primary` in `findBestFit`. The buffer is policy, not a knob.

## Non-Goals

- Real-time throttling estimation
- Network calls (HTTP, API, telemetry)
- Reading non-Claude Code session formats without explicit adapter