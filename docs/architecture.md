# Architecture and behavior

Anvil is a VS Code client for TrueForge. This guide covers the integration,
context selection, model settings, and the boundaries of review and execution.
For installation, see the [README](../README.md); for repository layout and test
setup, see the [development guide](development.md).

## Integration

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
  never calls a model provider. Agent definition: [`agents/anvil.json`](../agents/anvil.json) (also saved
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
  endpoint rejects. [`scripts/model-relay.ts`](../scripts/model-relay.ts) (≈30 lines, started by `npm run forge`)
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
   docs section, related files, a not-included list with reasons, and a short list of candidate files.
   Snippets shrink, then extras drop, until it fits.

Measured on Flask 3.1.3 over 8 tasks with known target files (`npm run eval`):
**recall@1 18/18** (implementation 8/8, test 6/6, docs 4/4). Without the code graph: 17/18 at @1, 18/18 at @3.

## Model settings

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
saved agent. [`docs/examples/settings.json`](examples/settings.json) is an example configuration.

## Review and recovery

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

## Limitations

- Free tiers are too small for long agent runs: Groq allows 8k tokens per minute per account, which also
  caps a single request (output included); Cerebras's trial allows a few requests a minute. Lean mode, two
  accounts and fresh-session recovery keep runs going, but a long multi-file task needs a paid tier.
- `run_command` adds `<copy>/src` to `PYTHONPATH`; other ecosystems may need their own setup.
- Retrieval picks one file per role; changes spanning several implementation files rely on the agent's reads.
- The MCP server is token-protected; edits and commands additionally consume one-use local approval grants. Approved commands still have host permissions.
- The small local model is slow on CPU and unreliable with tools; it is a last resort.
