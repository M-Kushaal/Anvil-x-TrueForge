# Anvil

A coding agent for VS Code whose agent loop runs on [TrueForge](https://github.com/truefoundry/trueforge).
It shows which code it chose and why, keeps every edit pending until you keep it hunk by hunk,
stops without leaving half-written files, and switches to another model by itself when one fails.

Built for the TrueFoundry Forge-a-thon (Techfest IIT Bombay 2026-27) by Matam Kushaal and Manit Jhanjharia.
**Starting point: from scratch** (no fork). Third-party code is used only as libraries, listed below.

## What it does

| | |
|---|---|
| **Inline edit** | Select code, `Ctrl+I`, type an instruction. The edit runs through TrueForge, is limited to the selection, ±2 lines (edits outside it are refused at the approval gate), and opens as a diff with **Keep / Reject on every change**. |
| **Agent mode** | A chat panel. One request drives a TrueForge tool loop that finds, reads and edits several files on its own: code, tests and docs. A live plan, one line per tool call, subagent threads. **History** (header button) reopens earlier chats and lists every inline edit. |
| **Context** | Before each request Anvil builds a **context pack** under a token budget: one file per role (implementation, test, docs) with outlines and line-numbered snippets, chosen by keyword (BM25), code-graph ([Graphify](https://github.com/Graphify-Labs/graphify)) and existing-pattern signals. `@file` and `@symbol` mentions come first. The chat shows every file, why it was chosen, and what was left out. |
| **Review** | Agent edits are **pending, not written**. Review in VS Code's diff editor, Keep or Reject each change; only Keep writes to disk (as a normal undoable edit). `Anvil: Revert Last Kept Change` puts a kept change back to pending. Commands the agent runs ask for Run / Skip on their row in the chat. |
| **Stop** | Esc or `Ctrl+Shift+Backspace` cancels the TrueForge turn, cuts any retry wait short and kills any running command. Nothing is half-applied: finished edits stay pending for review or can be rejected. |
| **Resilience** | Errors are classified (invalid key, missing model, rate limit, unreachable, timeout, oversized request, malformed tool call). Anvil waits out short rate limits, backs off on network errors, and **switches to the next configured model automatically**, continuing the same session. |

## Quick start (from a clean clone)

Requirements: Node ≥ 22.18, VS Code ≥ 1.100, Git. Optional: Python with `pip install graphifyy`
(code graph) and [Ollama](https://ollama.com) (offline fallback model).

```bash
git clone https://github.com/M-Kushaal/Anvil-x-TrueForge.git anvil && cd anvil
git clone --depth 1 --branch 3.1.3 https://github.com/pallets/flask ../flask   # the target repo (Tasks A-C)
npm install
cp .env.example .env          # GROQ_API_KEY (optionally GROQ_SECOND_KEY from another account); never committed

npm run forge                  # terminal 1: TrueForge on :8790 + model relays on :8791 (Groq) and :8792 (Cerebras)
npm run setup                  # terminal 2: registers models and the "anvil" agent in TrueForge
npm run build
```

Open this folder in VS Code and press **F5** (“Run Anvil on ../flask”), or run
`code --extensionDevelopmentPath=. <your project>`. The Anvil icon appears in the activity bar.

`npm run forge` runs `npx @truefoundry/trueforge@0.185.0` (the version Anvil was tested against; `@latest`
can change event shapes) with `OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]'`:
TrueForge's SSRF guard blocks loopback by default, and Anvil's MCP server runs on `127.0.0.1`. Only
loopback is allowed; the guard stays on for every other private address.

### Settings

| Setting | Default | |
|---|---|---|
| `anvil.models` | `groq/gpt-oss-120b`, `groq-2/gpt-oss-120b`, `groq/gpt-oss-20b`, `groq-2/gpt-oss-20b`, `ollama/qwen2-5-3b` | Model chain as named in TrueForge. First is primary; the rest are automatic fallbacks. The same model under two providers (two accounts) is a pair: on a rate limit Anvil uses whichever is free first. |
| `anvil.leanProviders` | `groq` | Providers with small per-request limits. Their models get a lean agent spec (no subagents, all tools preloaded, short output), a context pack of at most 1.8k tokens and compaction at 6k. Covers suffixed names too (`groq-2`). |
| `anvil.serverUrl` | `http://localhost:8790` | TrueForge. |
| `anvil.contextBudget` | `3000` | Token budget of the context pack. |
| `anvil.graphifyCommand` | `graphify` | Graphify executable (a path is resolved against the workspace). |
| `anvil.commandPath` | `[]` | Folders added to PATH for `run_command`, e.g. a virtualenv's `Scripts`/`bin`. |

To switch models, add a provider in TrueForge (Settings → Models) and list it in `anvil.models`; Anvil
sets the session's model from that list, so the model named in `agents/anvil.json` is only a default for the
saved agent. [`settings.example.json`](settings.example.json) is an example configuration.

## How it works

```
VS Code ─ Anvil extension ──────────────────────────────────────────────┐
  chat webview · inline edit · diff review (CodeLens) · Changes view     │
  ContextEngine (outline + BM25 + Graphify graph) → context pack         │
  DraftStore (staged edits, nothing written until Keep)                  │
  MCP server on 127.0.0.1 (token-protected)                              │
    read_file  search_code  outline  find_symbol  related_files         │
    list_dir   propose_edit  create_file  run_command  update_plan      │
└──────────────┬────────────────────────────────▲─────────────────────────┘
   SDK: sessions, streamed turns,               │ MCP tool calls
   in-turn approvals, cancel                    │
               ▼                                │
         TrueForge (local mode): agent loop, tool approval, subagents,
         deferred tool loading, compaction ──► models (Groq via relay, Ollama)
```

- **The agent decides what to read and change.** Every editor capability is an MCP tool; the extension
  never calls a model provider. Agent definition: [`agents/anvil.json`](agents/anvil.json) (also saved
  as the `anvil` agent by `npm run setup`).
- **TrueForge tool approval drives the review.** `propose_edit`, `create_file` and `run_command` require
  approval. When TrueForge pauses, Anvil validates the call with the same code that stages it (exact,
  unique match; file exists; inside the selection for inline edits) and denies bad calls with a reason
  the model can act on. Allowed edits become pending changes; the user keeps or rejects each one.
- **`run_command` runs on a throwaway copy** of the workspace with the staged edits applied (and without
  `.env` or key files), so tests check the proposal while your files stay untouched. It is not a sandbox:
  the command runs with your permissions, so every command asks first, including tests and help commands.
- **Harness features used:** tool approval (above), session update for in-place fallback, compaction
  (60k tokens; 6k for lean providers), and in the standard spec dynamic subagents (shown as threads) and
  deferred tool loading. Lean providers get subagents off and all tools preloaded instead.
- **One connector per workspace** (`anvil-editor-<hash>`), so two VS Code windows never route each
  other's tool calls.
- **Model relay.** TrueForge replays a reasoning model's `reasoning_content`, which Groq's OpenAI-compatible
  endpoint rejects. [`scripts/model-relay.ts`](scripts/model-relay.ts) (≈30 lines, started by `npm run forge`)
  removes that field and forwards to Groq: an AI gateway in front of the provider, not part of the extension.

### Context strategy

One file per role, ranked by keyword, code-graph and existing-pattern signals; a ~3k-token pack of
outlines and line-numbered snippets; the agent reads more on demand. Per request:

1. `@file` / `@symbol` mentions first, verbatim.
2. Roles from the request: implementation always; test and docs when asked for.
3. Implementation score: path and symbol matches (BM25), damped body matches, **existing pattern**
   (for “add a new X command”, files that already define `*_command`), identifiers named in the
   request, Graphify PageRank; files that match only the request's subject words are penalised.
4. Test and docs partners of the chosen file: Graphify links, naming, and mentions of the pattern.
5. Pack under the budget: outline, the pattern to copy, where it is registered, the matching test and
   docs section, related files, a not-included list with reasons, and the task repeated at the end.
   Snippets shrink, then extras drop, until it fits.

Measured on Flask 3.1.3 over 8 tasks with known target files (`npm run eval`):
**recall@1 18/18** (implementation 8/8, test 6/6, docs 4/4). Without the code graph: 17/18 at @1, 18/18 at @3.

## Tests

```bash
npm run check        # typecheck + unit, contract and webview regression tests
npm run test:e2e     # 6 end-to-end tests in a real VS Code (review, keep, undo, CRLF, new files)
npm run eval         # retrieval recall on ../flask
npm run test:live    # against a running TrueForge and real models (Task A, B, C)
```

Debugging aids: `RELAY_LOG=1 node scripts/model-relay.ts` prints where each request's tokens go and the
provider's remaining per-minute quota; `node scripts/session-log.mjs [sessionId]` prints a TrueForge
session's events one per line; `npm run preview` renders the chat panel in Dark and Light themes.

## Models used

| Model | Where | Cost |
|---|---|---|
| `openai/gpt-oss-120b`, `openai/gpt-oss-20b` | Groq cloud, free tier, two accounts, through the local relay | ₹0 |
| `qwen2.5:3b` | Ollama on a laptop CPU (offline fallback) | ₹0 |

## Known limitations

- Free tiers are too small for long agent runs: Groq allows 8k tokens per minute per account, which also
  caps a single request (output included); Cerebras's trial allows a few requests a minute. Lean mode, two
  accounts and fresh-session recovery keep runs going, but a long multi-file task needs a paid tier.
- `run_command` adds `<copy>/src` to `PYTHONPATH`; other ecosystems may need their own setup.
- Retrieval picks one file per role; changes spanning several implementation files rely on the agent's reads.
- The MCP server is token-protected; edits and commands additionally consume one-use local approval grants. Approved commands still have host permissions.
- The small local model is slow on CPU and unreliable with tools; it is a last resort.

## Credits and licence

MIT (see [LICENSE](LICENSE)). Uses TrueForge SDK (MIT), Model Context Protocol SDK (MIT), Graphify
(Apache-2.0, run as an external tool in its offline mode), Preact (MIT), marked (MIT), DOMPurify
(Apache-2.0/MPL-2.0), jsdiff (BSD-3-Clause), zod (MIT), Codicons (CC-BY-4.0).

## Review and recovery improvements

Pending proposals now persist in VS Code workspace storage, isolated by task. New Chat starts
an empty change set; reopening a chat restores its associated proposals. The folder icon in the
chat header recovers pending tasks, including tasks interrupted before their chat was saved.
Keeping a recovered proposal still checks the current file; new files that appeared meanwhile
are rejected instead of overwritten. Storage failures surface an error rather than silently losing work.

Save checkpoint / Restore checkpoint snapshots **pending proposals only**. It does not roll back
files already kept. Restore remains available after rejecting every pending change.

Every command requires Run / Skip, displaying the complete command. Local one-use grants expire
on Stop or task switches. Stop covers preparation and execution; New Chat, history resume and
extension disposal use the same cleanup. If the OS refuses process-tree cleanup, the retained log
warns that a descendant may remain running. This execution mode is not a sandbox.

Command results retain bounded output, exit status, cancellation/timeout and proposal revision.
The result panel labels results outdated after draft, buffer or indexed workspace changes. A passed
command does not imply all tests passed. Failed commands are marked failed in the activity trace.
Copies include unsaved buffers and captured drafts, omit credentials and dependency folders, and
skip symlinks. Dependencies must be available via the configured command environment or explicitly
installed as part of an approved command in the copy. Ecosystem isolation/adapters remain future work.

Keep All preflights every file, locks proposals during application and reports partial failures.
Application across files is sequential, not an atomic transaction. Kept-change undo history is scoped
to the current task during this extension session.

Use + beside the model to pin files. Context-card Pin / Exclude controls affect future initial packs;
exclusions do not prevent the agent from explicitly reading a file. Retrieval refreshes dirty buffers,
drafts and filesystem changes before constructing packs. File access checks canonical link targets;
these checks are best-effort path containment, not protection against every concurrent filesystem race.

The model label opens a selector, including registered server models. `anvil.allowModelFallback`
(default true) can limit execution to the primary model. Startup checks backend connectivity and
whether the primary model is registered. The launcher pins TrueForge to 0.185.0, matching the installed
SDK version; changing that pin requires live compatibility testing.

Additional retrieval regressions cover a separate JS/TS fixture, exclusions and staged new-file
mentions. These are regression cases, not a broad benchmark of general coding-agent performance.
