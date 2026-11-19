# Anvil: a coding agent that shows its work, on TrueForge

## 1. Team
Matam Kushaal (IIT Bombay, GitHub `M-Kushaal`) · Manit Jhanjharia (IIT Bombay, GitHub TBD)

## 2. Starting point
From scratch. No upstream fork; libraries only (TrueForge SDK, MCP SDK, Preact, jsdiff, marked, DOMPurify, zod,
Codicons). Graphify (Apache-2.0) runs as an external offline tool. Repository: https://github.com/M-Kushaal/Anvil-x-TrueForge.

## 3. Architecture on TrueForge
The extension is a TrueForge client: it creates sessions and streams turns with `@truefoundry/trueforge-sdk`,
renders every event (deltas merged, about 30 updates a second) and never calls a model provider. Editor
capabilities are an MCP server inside the extension (`127.0.0.1`, random port, bearer token), registered as a
connector named per workspace: `read_file`, `search_code`, `outline`, `find_symbol`, `related_files`, `list_dir`,
`propose_edit`, `create_file`, `run_command`, `update_plan`. The agent, not the extension, decides what to read
and change.

Harness features and why:
- **Tool approval drives the diff review.** `propose_edit`, `create_file`, `run_command` require approval.
  TrueForge keeps the turn open on `tool.approval_required`; Anvil validates the call (unique exact match,
  file exists, inside the selection for inline edits) and posts allow, or a deny with a fixable reason, via
  `createTurnEvents`. Allowed edits are staged in a draft layer; only the user's Keep writes to disk. Commands
  run on a copy of the workspace; once edits are staged, every command needs the user's OK.
- **Session update** (`sessions.update`) swaps the model in place on fallback, so the conversation continues.
- **Compaction**, configurable (`anvil.compactAt`), and lower for small-limit models.
- **Deferred tool loading and dynamic subagents** in the standard spec. For providers with small per-request
  limits (`anvil.leanProviders`, e.g. Groq's free tier) Anvil sends a lean spec instead: subagents and
  ask-user off, all tools preloaded, short output. Discovering tools cost a step after every compaction there.
- **Sessions as history.** Chats are saved per workspace and reopen on their TrueForge session; inline edits
  are turns in one shared session (renewed every few edits), listed in the History view.

Findings from the integration: TrueForge's SSRF guard blocks loopback MCP servers (we start it with
`OUTBOUND_URL_ALLOWED_HOSTS=["127.0.0.1"]` only); OpenAI-compatible endpoints (Groq, Cerebras) reject the
`reasoning_content` TrueForge replays for reasoning models, so a 30-line local relay strips it (a candidate
Round-2 PR); and compaction is triggered by the previous call's size, so one large tool result can overshoot a
small request limit. Anvil then continues in a fresh session carrying the task, plan and staged files.

## 4. How context is selected
One file per role (implementation, test, docs), ranked by keyword, code-graph and existing-pattern signals,
sent as a pack of outlines and line-numbered snippets under a token budget (default 3k); the agent reads more
through tools whose outputs are capped (100-line reads, ≤50 search hits) and start with a one-line summary.
Signals: BM25 per field (path, symbols, body; body log-damped), Graphify file graph (calls, imports,
inheritance; 1 hop; PageRank), existing pattern (for "add a new X command": files defining `*_command`, with
the closest one shown and the lines that register it), identifiers named in the request, test/doc pairing,
and a penalty for files matching only the subject words ("config" in Task B pulls toward `config.py` and
`docs/config.rst`; both are listed as not included, with reasons). To fit the budget, snippets shrink, then
extras drop; at the smallest level only file headers, reasons and the task remain. `@file` and `@symbol`
mentions come first (a symbol from its own definition). Greetings get no pack. The chat's Context card shows
each chosen file, its reasons and token cost, and what was left out.
Measured on Flask 3.1.3, 8 tasks with known targets: recall@1 18/18 (without the graph 17/18). The heuristics
were tuned on these tasks, so treat this as a regression check, not a general benchmark.

## 5. Model setup
| Model | Where it ran | Cost |
|---|---|---|
| `gpt-oss-120b`, `gpt-oss-20b` | Groq cloud, free tier, two accounts (`groq`, `groq-2`), via the local relay | ₹0 |
| `gpt-oss-120b` | Cerebras cloud, free trial credits, via the local relay | ₹0 |
| `qwen2.5:3b` | Ollama on a laptop CPU (offline fallback) | ₹0 |

Anthropic (Claude Haiku) is supported by `npm run setup` when a key is set, but was not used. Switch models by
adding a provider in TrueForge and listing it in `anvil.models`; Anvil sets each session's model from that list.
TrueForge itself runs locally, pinned to 0.185.0 (the version Anvil was tested against). Failures are classified (auth, missing model,
rate limit with retry-after, oversized request, network, timeout, server, malformed tool call, editor tools
unreachable); Anvil waits out short rate limits, uses whichever account serving the same model frees up first,
backs off on network errors, and falls back to the next model automatically (skipping models on a provider
whose key was rejected). Free tiers and a laptop CPU during development.

## 6. Scorecard
| Criterion | Video | Claim |
|---|---|---|
| A1 Inline edit | TBD | Diff with Keep/Reject per change; edits limited to the selection (±2 lines) |
| A2 Agent mode | TBD | Task B: implementation, test and docs found without being named (to be shown live) |
| A3 Streaming and cancellation | TBD | Events stream; Stop cancels the turn, cuts waits short and kills commands; 0 files written |
| B1 Context assembly | TBD | Budgeted pack, reasons and left-out files shown; @-mentions; recall@1 18/18 |
| B2 Diff safety | TBD | Pending edits, per-change Keep/Reject, Revert Last Kept Change, commands on a copy |
| B3 Resilience | TBD | Invalid key → automatic switch to the next model; git status clean |
| B4 TrueForge depth | TBD | MCP tools, approval-driven review, session update, compaction, lean vs. standard spec |
| C1 Video | TBD | Tasks A, B, C in order, each verified on screen; TrueForge session shown during Task B |
| C2 Write-up | — | This document: eight sections, scorecard with timestamps, models and costs declared |

## 7. Tools used
Claude Code (Claude) and OpenAI Codex for implementation, documentation, and code review. Graphify (offline code graph). Vitest,
@vscode/test-electron. README images: SVG branding and UI previews rendered from application components with example data.

## 8. Known limitations and next month
- Free tiers are too small for long agent runs (Groq: 8k tokens per request; Cerebras trial: a few requests
  a minute). Task B needs a paid tier or a larger-context provider.
- Retrieval picks one file per role; refactors across several implementation files rely on the agent's reads.
- The MCP server trusts any call that reaches it with the token; approval is enforced in the session spec.
- `run_command` runs a copy of the workspace with the user's permissions (secrets left out); it is not a
  sandbox. Its `PYTHONPATH` setup targets `src/`-layout Python projects.
- The local fallback model is slow on CPU and weak with tools.
Next: contribute reasoning-replay handling for OpenAI-compatible providers to TrueForge; @-mention
autocomplete; a checkpoint per turn; streaming command output; per-call approval tokens in the MCP server.
