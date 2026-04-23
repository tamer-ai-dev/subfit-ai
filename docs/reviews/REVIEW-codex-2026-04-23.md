# Codex review

## Findings

1. **`assistantLines` drives the subscription verdict even though the code claims to reason about messages that have usage.**
   Refs: [subfit-ai.ts](subfit-ai.ts:430), [subfit-ai.ts](subfit-ai.ts:433), [subfit-ai.ts](subfit-ai.ts:1214), [README.md](README.md:69).
   `scanJsonl()` and `scanGeminiSession()` bump `assistantLines` before validating the `usage` / `tokens` block, and then `main()` passes `ctx.assistantLines` to `computeSubscriptionStats()`. So the 5h verdict can be inflated by assistant turns that carry no metrics, even though the README explicitly says "keeps only lines ... with a `message.usage` block". The Gemini test even encodes this behaviour as expected: [tests/gemini.test.ts](tests/gemini.test.ts:121). For a pricing tool, this is the core result going wrong.

2. **Gemini support breaks the semantics of the "Claude $" column and of "What you actually paid to Anthropic".**
   Refs: [README.md](README.md:74), [subfit-ai.ts](subfit-ai.ts:618), [subfit-ai.ts](subfit-ai.ts:651), [config.json](config.json:10).
   Since the `gemini-*` buckets were added, `computeRows()` pulls `pricing[model]` without distinguishing provider and then shows the result under the `Claude $` column. For Gemini rows you are therefore displaying a Gemini-API cost under a "Claude $" label, and the "Codex / Claude" ratio becomes wrong. Same problem in the Markdown export. The README still promises "What you actually paid to Anthropic". No. The report mixes multi-provider costs with Claude-only vocabulary.

3. **`--demo` is not isolated: it keeps scanning `~/.gemini` if the directory exists.**
   Refs: [subfit-ai.ts](subfit-ai.ts:1155), [subfit-ai.ts](subfit-ai.ts:1161), [subfit-ai.ts](subfit-ai.ts:1174), [README.md](README.md:98), [README.md](README.md:110).
   `--demo` only overrides `args.path`. `args.geminiPath` stays pointed at the real root. On a machine that has the Gemini CLI installed, the "synthetic fixture" demo is polluted by the user's actual Gemini sessions. So zero reproducibility, zero "zero setup", and the demo output depends on the local machine.

4. **The Markdown export misrepresents the scan when Gemini participates, or worse when the run is Gemini-only.**
   Refs: [subfit-ai.ts](subfit-ai.ts:1042), [subfit-ai.ts](subfit-ai.ts:1254), [subfit-ai.ts](subfit-ai.ts:1287).
   `renderMarkdown()` only receives `scanPath` and `filesScanned` from the Claude side. If the user scans only Gemini, the exported report can display `0 JSONL file(s) under ~/.claude` while the actual analysis came from `~/.gemini`. The export is no longer a faithful record of the run.

5. **The unknown-model warning is wrong as soon as an unknown Gemini model shows up.**
   Refs: [subfit-ai.ts](subfit-ai.ts:507), [subfit-ai.ts](subfit-ai.ts:1206).
   `normalizeGeminiModel()` falls back to `gemini-pro`, but the global warning still says "bucketed as Claude Opus" and only points at `normalizeModel()`. The operational message is wrong. When someone is debugging pricing, this sends them to the wrong spot.

6. **The README is already drifting from the real config.**
   Refs: [README.md](README.md:219), [config.json](config.json:5).
   The config example documents `Claude Opus 4` at `15 / 75 / 1.5 / 18.75`; the actual embedded config is `5 / 25 / 0.5 / 6.25`. Not a cosmetic detail: the repo sells pricing, and the README shows different numbers. Same drift for Haiku (`0.80 / 4.0 / 0.08 / 1.0` vs `1.0 / 5.0 / 0.10 / 1.25`).

## What's missing

- End-to-end tests for mixed Claude+Gemini cases against terminal / Markdown / JSON rendering.
- A `--demo` test that guarantees no real provider data is read.
- A test that protects the "README and config agree" invariant, or a README generated from a single config source. The drift is already visible.
- Conceptual clarification: what is the tool actually comparing when the source is Gemini? "Real cost at the native provider"? "Equivalent cost on Claude"? "Equivalent cost on Codex"? Today the prose and the columns say several incompatible things.

## Raw take

Solid utility baseline, readable code, clean unit tests. But the product tells a cleaner story than reality. Adding Gemini cut across compute layers without reworking the vocabulary or the outputs. Result: potentially wrong numbers on the subscription verdict, wrong labels on costs, README already out of sync. Before a new feature, I would lock down the business definition and write 2-3 integration tests that snapshot the mixed output.
