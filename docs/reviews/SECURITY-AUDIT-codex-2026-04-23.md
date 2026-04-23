# Codex security audit

## Findings

1. **`docker build` exfiltration footgun: the repo ships Docker instructions but no `.dockerignore`.**
   Refs: [Dockerfile](Dockerfile:5), [Dockerfile](Dockerfile:18), [README.md](README.md:97), [README.md](README.md:118).
   You explicitly invite people to run `docker build -t subfit-ai .`, but the repo has no `.dockerignore`. Consequence: Docker sends the entire local build context to the daemon / builder before any `COPY` is applied. In this workspace there are already dotdirs and local artefacts (`.claude/`, `.codex`, `.opencode/`, `logs/`, uncommitted review files). On a remote buildkit, cloud builder, or a hacked-together CI, this becomes a trivial data leak. On HN someone will try it on a dirty machine and then discover that the "offline" tool shipped their personal context to the build.

2. **Easy memory DoS: every input file is loaded fully into RAM.**
   Refs: [subfit-ai.ts](subfit-ai.ts:424), [subfit-ai.ts](subfit-ai.ts:429), [subfit-ai.ts](subfit-ai.ts:526), [subfit-ai.ts](subfit-ai.ts:533), [subfit-ai.ts](subfit-ai.ts:102), [subfit-ai.ts](subfit-ai.ts:261).
   `scanJsonl()` does `readFileSync(..., "utf-8")` then `split("\n")`. `scanGeminiSession()` does the same on the whole JSON. `loadConfig()` too. No size cap, no streaming, no timeout, no file-count limit. A hostile or just oversized directory can blow up memory and CPU with no effort. Not an RCE, but for a CLI that strangers will pull after HN, it is the classic "this freezes / crashes my laptop" bug.

3. **Terminal / log injection via unrecognized `model` strings coming from scanned files.**
   Refs: [subfit-ai.ts](subfit-ai.ts:442), [subfit-ai.ts](subfit-ai.ts:545), [subfit-ai.ts](subfit-ai.ts:1231), [subfit-ai.ts](subfit-ai.ts:1236).
   Unknown model IDs are taken verbatim from the JSONL / JSON and re-emitted on `stderr`. If a crafted file carries newlines, ANSI sequences, OSC 8, etc., the terminal output can be polluted, disguised, or made to render misleading links / colours. Impact is limited to local terminal injection, not code execution, but it is exactly the kind of embarrassing demo that an HN reader can post as a screenshot.

4. **`--export` allows arbitrary overwrite of any writable file.**
   Refs: [subfit-ai.ts](subfit-ai.ts:178), [subfit-ai.ts](subfit-ai.ts:185), [subfit-ai.ts](subfit-ai.ts:1310), [subfit-ai.ts](subfit-ai.ts:1320), [subfit-ai.ts](subfit-ai.ts:1347).
   Technically this is not a "path traversal" exploit since the user picks the path. But in practice it is a clobber with no guard: `--export ~/.bashrc`, `--export package.json`, `--export ../README.md` overwrite anything with just a warning. If someone later wraps this binary in a naive UI or web shim, it instantly becomes a write primitive.

5. **Unbounded recursive parser on `--path` / `--gemini-path`: a massive or weirdly mounted directory can render the tool unusable.**
   Refs: [subfit-ai.ts](subfit-ai.ts:257), [subfit-ai.ts](subfit-ai.ts:264), [subfit-ai.ts](subfit-ai.ts:278), [subfit-ai.ts](subfit-ai.ts:481), [README.md](README.md:131).
   `findJsonlFiles()` and `findGeminiSessions()` walk with no quotas and no depth filters. You skip a few top-level noise directories, nothing more. If a path points by mistake at `$HOME`, a network mount, a huge dump, or a tree full of thousands of files, the user eats a potentially enormous scan. Not a server-side vulnerability, but poor robustness for a public-facing tool.

6. **The "offline" claim holds for runtime but is less accurate for the supply chain / image build.**
   Refs: [README.md](README.md:31), [CLAUDE.md](CLAUDE.md:54), [Dockerfile](Dockerfile:16).
   The project sells itself as "no network call". For script execution, yes. But the Dockerfile does `npm install -g tsx@4` at build time, so the build is non-reproducible without a pinned digest / lockfile, and it is not "offline" at all. Same story for `npx tsx` on the usage side. Not a direct application flaw, but it publicly opens the "offline except when it downloads code" angle. On HN someone will call it out.

## Personal data / embarrassing bits

- In the committed files I read: no API key, token, secret, personal email, or real session dump. `examples/sample.jsonl` looks synthetic.
- `config.json` only contains public pricing URLs. Nothing sensitive.
- The local `.git/config` contains `git@github.com:tamer-ai-dev/planfit.git` and `[email protected]`, but it is not versioned. Not a problem for the public repo per se.
- `.claude/settings.json` exists in the workspace but reading it was blocked by sandbox permissions. Key point: if those permissions change and you run Docker builds without `.dockerignore`, that kind of file can leak into the build context.
- The repo promises "single-file CLI" and "zero runtime dependencies", but shipping Docker + npm build + assorted agent docs ends up less minimal than the pitch. Not a security issue, but an easy angle for snark.

## Raw take

No obvious secret in what is heading to GitHub. No RCE via `config.json`: it is `JSON.parse`, end of story. No classic path traversal either. The real security topic is local robustness and tooling hygiene: the Docker build context that can suck up personal files, unbounded scans, full-file reads in memory, and a few unsanitized terminal outputs. For a Hacker News post, I would fix `.dockerignore` and size / streaming limits first. The rest is mostly "local footgun" territory, but footguns make the best HN comments.
