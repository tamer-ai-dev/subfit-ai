# Changelog

All notable changes to this project will be documented here. Format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `--demo` flag that scans a bundled `examples/sample.jsonl` so the tool
  can be tried without any Claude Code data on disk.
- Vitest unit tests for `normalizeModel`, `verdict5h`, `findBestFit`,
  `costOn`, and `computeSubscriptionStats`.
- `tsconfig.json` + `npm run typecheck` (strict `tsc --noEmit`).
- GitHub Actions CI running typecheck + tests on Node 18 / 20 / 22.
- `CLAUDE.md` and `CONTRIBUTING.md` for contributor onboarding.
- `_source` URLs on all OpenAI plan entries; Claude Max entries already
  carried their Anthropic support-article source.

### Changed
- Volatility warning rewrites the "GitHub docs #37, #38" reference as
  "community reports" (the numbered docs were opaque and unverifiable).
- README example output fixes the best-fit inconsistency (OpenAI Pro at
  $100/mo wins over Pro 20x at $200/mo for the illustrated usage).
- `normalizeModel` docstring enumerates the wire-name coverage
  (`claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`…).

## [1.1.0] — 2026-04-22

### Added
- Subscription comparison with official Anthropic plan caps (Pro, Max 5x,
  Max 20x, Team, Enterprise) plus OpenAI Plus / Pro / Pro 20x.
- 5-hour verdict with a `MARGINAL (N% of limit)` band at 80% of the
  ceiling; MARGINAL plans are not eligible as `primary` in the best-fit
  recommendation.
- Session-count tracking (`1 JSONL file ≈ 1 session`) with the 50
  sessions/mo cap enforced for Claude Max tiers.
- Best-fit recommendation that surfaces `cheaperMarginal` / `headroomAlt`
  when the natural pick has trade-offs.
- `--export` flag for GitHub-flavoured Markdown reports.
- `--json` payload including `subscriptionVerdicts`, `bestFit`,
  `unknownModels`.
- `default-config.json` embedded fallback so the binary keeps working if
  the user's `config.json` is missing or malformed.

### Fixed
- OpenAI Codex `cacheWrite: 0` — without the explicit zero, the
  `cacheWrite ?? input` fallback in `costOn()` was overstating Codex
  costs.
- Model rows no longer skip entirely when a Codex tier pricing is
  missing; the affected columns render `—` instead.
