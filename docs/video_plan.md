# Anvil testing and video plan

Use PowerShell for the commands below. Both `npm run forge` and `npm run setup` run from the Anvil repository folder. The launcher starts TrueForge 0.185.0 and the local model relays.

## 1. Prepare Anvil

Open PowerShell window 1 and run these commands.

```powershell
cd 'C:\Users\kusha\OneDrive\Desktop\Hackathons\TrueFoundry Forge-a-thon\Anvil-x-TrueForge'
npm ci
npm run build
```

If `.env` already contains your keys, use that file. Otherwise create it once with the following command.

```powershell
Copy-Item .env.example .env
```

Open it, enter your provider key, save, and close Notepad. Keep the key off screen during recording.

```powershell
notepad .env
```

## 2. Start TrueForge

In the same PowerShell window, run this and leave it running.

```powershell
npm run forge
```

Wait for TrueForge to report that it is listening. Open `http://localhost:8790` in your browser. Keep that tab ready for the Task B session demonstration.

## 3. Register models and load the agent

Open PowerShell window 2 and run these commands while window 1 stays open.

```powershell
cd 'C:\Users\kusha\OneDrive\Desktop\Hackathons\TrueFoundry Forge-a-thon\Anvil-x-TrueForge'
npm run setup
code .
```

Setup registers the configured models and loads `agents/anvil.json`. Check the printed model names. In VS Code, open the Anvil model settings and choose a registered model if the default is unavailable.

## 4. Launch and test the extension

Select **Run Anvil on clean Flask AB** in VS Code Run and Debug before pressing F5. For Task C select **Run Anvil on clean Flask C**.

1. In the VS Code window opened by `code .`, press **F5**.
2. Wait for the new **Extension Development Host** window to open on Flask.
3. Click the **Anvil** activity bar icon in that new window.
4. Send `Explain what this project does` and check that output streams into the chat.
5. Open a source file, select a small function, press **Ctrl+I**, and ask for a small edit.
6. Inspect the proposed diff, then use **Keep** or **Reject** on a hunk.

For terminal verification, open an integrated PowerShell terminal in the Flask window and run the following. This uses the existing Python environment next to the project.

```powershell
cd 'C:\Users\kusha\OneDrive\Desktop\Hackathons\TrueFoundry Forge-a-thon\flask-video-ab'
$env:PYTHONPATH = (Resolve-Path .\src).Path
$python = (Resolve-Path '..\.flask-venv\Scripts\python.exe').Path
& $python -m pytest --version
git rev-parse --short=8 HEAD
git status --short
```

For the recording, Flask must be at tag `3.1.3`, commit prefix `22d92470`, with a clean starting status. Preserve any existing work before preparing a clean recording checkout. Rehearse before starting the capture.

## 5. Prepare the demonstration app

In the Flask integrated terminal, create an app outside the checkout using fake values.

```powershell
$demoApp = Join-Path $env:TEMP 'anvil_demo_app.py'
@(
  'from flask import Flask'
  'app = Flask(__name__)'
  'app.config.update(DEMO_TOKEN="fake-token", DEMO_LABEL="anvil-demo")'
) | Set-Content -Encoding utf8 $demoApp
```

Keep this terminal open so `$python`, `$env:PYTHONPATH`, and `$demoApp` remain available for the checks below.

## 6. Record Task A

Open `src/flask/helpers.py`, select the full `get_debug_flag` function, press **Ctrl+I**, and submit this exact instruction.

> Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.

Show the diff and individual Keep/Reject controls. **Keep the edit before verification**, then run this in the Flask terminal.

```powershell
$env:FLASK_DEBUG = 'off'
& $python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"
Remove-Item Env:FLASK_DEBUG
```

Leave the `False` result visible briefly.

## 7. Record Task B

Start a new Anvil chat with no attached or pinned files. Submit this exact instruction.

> Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.

1. Show the Context card with file names, selection reasons and token budget.
2. Show pending hunks across at least three files covering implementation, tests and docs.
3. Switch briefly to TrueForge in the browser. Open the session for this request and show its model activity and MCP calls. Show an approval event if available. Only describe compaction or deferred loading if visible in the session.
4. Return to VS Code, review the hunks and keep the changes.
5. Run the following in the same Flask terminal.

```powershell
& $python -m flask --help
& $python -m pytest tests/test_cli.py -q
& $python -m flask --app "$demoApp" config
```

Show the `config` help entry, passing tests, `"DEMO_TOKEN": "***"`, and the unchanged `"DEMO_LABEL": "anvil-demo"`.

## 8. Record Task C and Stop

Prepare a second clean Flask checkout at the same commit before recording C. Open it through Anvil's extension host by changing the Flask workspace argument in `.vscode/launch.json` to that checkout and pressing F5 again.

1. Configure a registered test provider with an invalid key or unreachable endpoint. Hide credentials. To demonstrate fallback, put a working provider second in `anvil.models`.
2. On the clean checkout, select `get_debug_flag` and repeat the exact Task A instruction.
3. Show the readable error or automatic fallback. Leave any resulting diff pending.
4. Click another editor file to show responsiveness. Run `git status --porcelain` in this checkout and show the empty output.
5. Reject any pending proposal, start a separate request, show activity streaming, click **Stop**, and show the stopped state and another empty `git status --porcelain`.

## 9. Timing and submission

Aim for **3:50**, under the four-minute maximum. Keep tasks A, B and C in order. Preserve the continuous sequence from each instruction through its diff appearing.

| Target time | Show |
|---|---|
| 0:00–0:08 | Anvil, Flask commit and clean status |
| 0:08–0:55 | Task A diff, Keep and `False` |
| 0:55–2:45 | Task B context, three files, TrueForge session and verification |
| 2:45–3:35 | Task C failure or fallback and clean status |
| 3:35–3:50 | Streaming, Stop and clean status |

Watch the exported video. Add its actual playback timestamps to `docs/writeup.md`, then regenerate `docs/writeup.pdf`. Upload the video as YouTube unlisted or a Google Drive file shared with anyone who has the link, and check access signed out.

| Scorecard row | Timestamp cue |
|---|---|
| A1 · Inline edit | Task A diff and hunk controls |
| A2 · Agent mode | Task B multi-file proposal |
| A3 · Streaming and cancellation | Visible activity and Stop |
| B1 · Context assembly | Context card and budget |
| B2 · Diff safety | Keep or Reject action |
| B3 · Resilience | Task C error/fallback and clean status |
| B4 · TrueForge depth | Matching session and MCP calls |
| C1 · Video | Start of the task sequence |
| C2 · Write-up | Submitted PDF |

The prepared `flask-video-ab` and `flask-video-c` folders contain pristine files exported from upstream commit `22d924701a6ae2e4cd01e9a15bbaf3946094af65`. GitHub was unreachable during preparation, so their local baseline commit IDs differ from upstream. For submission, use a direct upstream clone at tag `3.1.3` once network access works.

## Fresh workspace on every debug launch

Choose **Run Anvil on fresh Flask** and press F5. After building Anvil, the launch task creates a new checkout at upstream commit `22d92470` under `.cache/debug/flask-*` and opens it in the Extension Development Host. Each launch has its own Git baseline and Anvil workspace state. Previous runs remain on disk. The AB and C launch options also create fresh copies. Complete A and B within one launch if you want to keep both tasks in that workspace.

Open a new integrated terminal inside the launched Flask workspace. For WSL, run `export PYTHONPATH="$PWD/src"` and `alias python=python3` there before verification. A new workspace has a new path, so use its integrated terminal for commands.

## Reusing one workspace for Task C

After keeping Task A and all three Task B files, run `/rewind` and confirm once to revert Task B. Run `/rewind` and confirm again to revert Task A. Rewind removes kept file changes without reopening them as proposals. Run `git status --porcelain` and verify it is empty before recording the failure case. Then disable fallback, select the provider whose endpoint you will break, change that endpoint in TrueForge, and repeat Task A. Restore the endpoint after the demo. Rewind history currently lasts for the running extension session. Restarting the extension clears that history.
