# Anvil on TrueForge

TrueFoundry Forge-a-thon · Techfest IIT Bombay 2026–27

## 1. Team

**Never_Gonna_Give_You_Up** | Techfest Team ID **TM-3DD65A68A2F**

| Member | College | GitHub |
|---|---|---|
| Matam Kushaal | IIT Bombay | [@M-Kushaal](https://github.com/M-Kushaal) |
| Manit Jhanjharia | IIT Bombay | [@Osama-Bin-Lagging](https://github.com/Osama-Bin-Lagging) |

## 2. Starting point

**We built Anvil from scratch.**

Anvil is an original VS Code extension released under the MIT license. It uses TrueForge to run the coding agent. We use Flask 3.1.3 (commit `22d92470`) for the demo and to check how well Anvil finds relevant code. [Anvil source repository](https://github.com/M-Kushaal/Anvil-x-TrueForge)

## 3. Architecture on TrueForge

Anvil uses the TrueForge SDK to start conversations and show the model's responses and tool activity as they arrive. TrueForge 0.185.0 runs on the user's machine and connects to the chosen model provider. An authenticated local MCP connection lets the agent use the editor tools below.

| Editor capability | MCP tools |
|---|---|
| Read and navigate | `read_file`, `list_dir`, `search_code`, `outline`, `find_symbol`, `related_files` |
| Stage edits and verify | `propose_edit`, `create_file`, `run_command` |
| Show progress | `update_plan` |

Anvil checks proposed edits before showing them for review. The user chooses **Keep** or **Reject** for each change. Commands require approval and run on a temporary copy that includes pending edits, so users can check a change before applying it. **Stop** interrupts the response and asks TrueForge to cancel the run.

Users can switch models without leaving the conversation using `/model`, inspect reported token counts with `/usage`, and undo the latest accepted edit request with `/rewind`. Rewind asks for confirmation and restores all files changed by that request. Repeating it steps back through earlier requests in the current extension session. Ctrl+I sends the selected filename and lines to the sidebar for an inline edit, then returns to the previous chat.

TrueForge shortens older conversation history through compaction. Standard sessions load tools when needed and can delegate work to subagents. Lean sessions load tools upfront and disable subagents to keep smaller requests simple. When the agent needs an answer, Anvil shows clickable choices and a text box.

## 4. How context is selected

Anvil searches file paths, code symbols and text using BM25, a keyword-ranking method. When available, Graphify links help it find related code. It also looks for matching tests and documentation. Files and symbols named with `@file` or `@symbol` take priority.

The first context pack includes one file for each needed role, with outlines and line-numbered excerpts. Its default budget is about **3,000 tokens**, with a smaller budget for lean models. Anvil shortens excerpts before dropping optional material. The Context card shows which files were chosen, why they were chosen and their estimated token use. The agent can read more through MCP when needed.

In eight local Flask checks with Graphify, Anvil's top-ranked results found the expected files in **8/8 implementation, 6/6 test and 4/4 documentation** cases. We used these same tasks to improve retrieval, so these results are development checks rather than an independent evaluation.

## 5. Model setup

| Model | Where it ran | Approximate cost |
|---|---|---|
| GPT-OSS 120B / 20B | Groq cloud through a local relay | INR 0 on development free tier |
| GPT-OSS 120B, default | Cerebras cloud through a local relay | INR 0 using development trial credits |
| Claude Haiku 5.5 | Anthropic API; used during demo rehearsal | Approximately US$0.05 total |
| Qwen 2.5 3B | Ollama on a laptop CPU | INR 0 in API charges |

`npm run setup` registers the model providers and agent. Users choose a model with `/model` or the model picker beside the message box. The `anvil.models` setting lists backup models in order, and `anvil.allowModelFallback` enables automatic switching. Chat and inline edits retry recoverable failures, with a maximum of 24 attempts per run. The zero-cost entries above reflect development free tiers and trial credits.

## 6. Scorecard

[Demo video](<https://drive.google.com/file/d/1HM96QAkTnalrMM1jFUjyX8wES2yMvt6L/view?usp=sharing>) ? **Runtime 3:53**, within the four-minute limit.

Timestamps mark task starts supplied for the final video. Related judging criteria refer to the segment containing their demonstration. Task A starts at 0:00, Task B at 0:46, and Task C at 2:06.

| Judging criterion | Video timestamp | One-line claim |
|---|---|---|
| A1 · Inline edit | 0:00 | Task A stages the selected Flask edit for individual hunk review. |
| A2 · Agent mode | 0:46 | Task B discovers the CLI implementation, tests and docs from an unattached prompt. |
| A3 · Streaming and cancellation | 0:00; 2:06 | Model and tool activity streams in the sidebar, and Stop interrupts the turn. |
| B1 · Context assembly | 0:46 | The Context card shows selected files, reasons and the estimated token budget. |
| B2 · Diff safety | 0:00; 0:46 | Per-hunk Keep/Reject and confirmed operation-level rewind control file changes. |
| B3 · Resilience | 2:06 | An unreachable selected provider produces a clear error while the workspace remains unchanged. |
| B4 · TrueForge depth | 0:46 | The matching Task B session shows streamed turns and approval-gated MCP calls. |
| C1 · Video | 0:00; 0:46; 2:06 | Tasks A, B and C are presented in order with on-screen verification. |
| C2 · Write-up | PDF | This document covers architecture, retrieval, models, costs and limitations. |

## 7. Tools used

Claude Code and OpenAI Codex assisted with implementation, documentation and review. Graphify built the offline code graph. Vitest and VS Code’s test runner support verification. README previews were rendered from Anvil’s UI components using example data.

## 8. Known limitations and what you would do with another month

The first context pack includes only one file per role, so larger changes need extra reads. Provider quotas can interrupt long runs, and the local CPU model is slow when a task needs many tool calls. Verification commands require approval and run in a temporary copy, but still have the user's machine permissions. Undo history is lost when the extension restarts. Token counts depend on what TrueForge reports and may be missing from older conversations. Retries can also make a run take longer, up to the overall attempt limit.

With another month, we would include more implementation files in the first context pack and test retrieval on repositories we did not use during development. We would also give verification commands a stronger isolation boundary, show their output as it arrives, and contribute a TrueForge fix for replaying reasoning messages with OpenAI-compatible providers.
