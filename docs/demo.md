# Round 1 recording checklist

Use Flask 3.1.3 at commit `22d92470`. Start with a clean checkout and record in A, B, C order. Keep the editor visible and the final video at or below four minutes. Preserve the sequence from each instruction to its diff.

## A. Inline edit

Select `get_debug_flag` in `src/flask/helpers.py` and use inline edit:

> Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.

Show the diff and individual Keep and Reject controls. Demonstrate undo, then accept the edit. Run `FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"` and show `False`. In PowerShell, set `$env:FLASK_DEBUG = 'off'` before running Python.

## B. Agent mode

Open a new chat without attached files and send:

> Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.

Show the context budget and file-selection reasons, then the three or more discovered files and their hunks. Show the TrueForge session with the tool calls and a harness feature such as deferred tool loading or compaction. Accept the changes, show `flask --help`, run `pytest tests/test_cli.py -q`, then run `flask --app <demo-app> config` against an app with fake sensitive values and a public value so both outcomes are visible.

## C. Resilience

Return to a clean Flask baseline where the Task A edit has not been applied. Configure an invalid key or unreachable endpoint in TrueForge, then repeat Task A. Show the clear error or automatic fallback, keep the resulting edit pending, and show empty output from `git status --porcelain`. Capture a Stop demonstration with a clean workspace for the cancellation criterion.

## Portal links

- Public GitHub repository with the final commit, README, example config, agent definition, and license.
- Public or unlisted demo video with the required verification visible.
- Public 1–3 page write-up PDF with the eight headings in order. Fill the scorecard with actual video timestamps and list the models and costs from the recorded runs.
