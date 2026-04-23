# Study: Gemini CLI Token Storage & Subfit-ai Adapter

This document analyzes how Gemini CLI persists session and token usage data, comparing it with Claude Code to propose a `subfit-ai` adapter.

## 1. Data Locations

Gemini CLI stores its data in `~/.gemini/`.

### Project Mapping
File: `~/.gemini/projects.json`
Role: Maps absolute workspace paths to "slugs" used for temporary storage.
Format: JSON
Example:
```json
{
  "projects": {
    "/path/to/workspace/subfit-ai": "subfit-ai"
  }
}
```

### Session Data
Path: `~/.gemini/tmp/<slug>/chats/`
Files: `session-YYYY-MM-DDTHH-mm-ID.json` (e.g., `session-2026-04-23T06-55-3a50492c.json`)
Format: **Single JSON object** per session (not JSONL).

## 2. Token Data Format

In Gemini CLI session files, each assistant turn is an entry in the `messages` array with `type: "gemini"`.

### Structure
```json
{
  "id": "...",
  "timestamp": "2026-04-23T06:57:24.342Z",
  "type": "gemini",
  "content": "...",
  "tokens": {
    "input": 7249,
    "output": 83,
    "cached": 5722,
    "thoughts": 253,
    "tool": 0,
    "total": 7585
  },
  "model": "gemini-3-flash-preview"
}
```

### Fields available:
- `input`: Standard input tokens.
- `output`: Standard output tokens.
- `cached`: Tokens served from cache (equivalent to Claude's `cache_read_input_tokens`).
- `thoughts`: Tokens used for internal reasoning (if applicable to the model).
- `tool`: Tokens used for tool calls/results.
- `total`: Aggregate sum.
- `model`: The model used (e.g., `gemini-3-flash-preview`).

## 3. Comparison with Claude Code

| Feature | Claude Code | Gemini CLI |
|---------|-------------|------------|
| **Storage Root** | `~/.claude/projects/` | `~/.gemini/tmp/` (slotted by slug) |
| **File Format** | JSONL (one event per line) | JSON (one object per session) |
| **Usage Field** | `message.usage` | `tokens` |
| **Input Tokens** | `input_tokens` | `input` |
| **Output Tokens** | `output_tokens` | `output` |
| **Cache Read** | `cache_read_input_tokens` | `cached` |
| **Cache Write** | `cache_creation_input_tokens` | *Not explicitly separated* |

## 4. Proposed Adapter for subfit-ai

To support Gemini CLI in `subfit-ai`, the tool needs to:

1.  **Discovery**:
    - Iterate through `~/.gemini/tmp/*/chats/`.
    - Alternatively, read `~/.gemini/projects.json` to identify active projects and their slugs.

2.  **Parsing**:
    - Use `JSON.parse()` on the entire file (unlike the line-by-line `JSON.parse()` for Claude's JSONL).
    - Filter `messages` where `type === "gemini"` and `tokens` exists.

3.  **Normalization**:
    - Map `gemini-3-*` models to equivalent cost tiers in `config.json`.
    - Map `tokens.input` -> `input_tokens`.
    - Map `tokens.output` -> `output_tokens`.
    - Map `tokens.cached` -> `cache_read_input_tokens`.

## 5. Conclusion
Gemini CLI persists token data locally in a structured JSON format. It is easily accessible but requires a different parsing strategy than Claude Code due to being a single JSON object instead of a JSONL stream.
