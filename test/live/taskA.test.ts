// Task A, live: inline edit of get_debug_flag through TrueForge. The staged proposal is applied to
// a temporary copy of Flask (never the real checkout) and checked by running Python.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DraftStore } from '../../src/drafts/store';
import { editTools, type EditContext } from '../../src/mcp/editTools';
import { readTools } from '../../src/mcp/readTools';
import { startInlineEdit } from '../../src/inline/run';
import { FLASK, MODEL, startLive, type Live } from './harness';

const PYTHON = path.resolve(FLASK, '../.flask-venv/Scripts/python.exe');
const INSTRUCTION = "Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.";

let live: Live;
const drafts = new DraftStore();
const real = (p: string) => readFileSync(path.join(FLASK, p), 'utf8').replace(/\r\n/g, '\n');
const edits: EditContext = { drafts, realText: async (p) => { try { return real(p); } catch { return undefined; } }, model: () => MODEL };

beforeAll(async () => { live = await startLive({ tools: (ws) => [...readTools(ws), ...editTools(edits)] }); });
afterAll(() => live.close());

describe('Task A (live)', () => {
  it('stages a scope-locked edit that makes FLASK_DEBUG=off false, without touching the checkout', async () => {
    const original = real('src/flask/helpers.py');
    const handle = startInlineEdit({
      deps: { client: live.client, edits, ensureReady: async () => undefined },
      request: { path: 'src/flask/helpers.py', startLine: 28, endLine: 33, instruction: INSTRUCTION, text: original, language: 'python' },
      model: MODEL,
    });
    const result = await handle.done;
    console.log(result.outcome, `pending=${result.pending}`);
    expect(result.outcome.status).toBe('done');
    expect(result.pending).toBeGreaterThan(0);
    expect(real('src/flask/helpers.py')).toBe(original); // nothing written

    const proposed = drafts.view('src/flask/helpers.py')!;
    console.log(proposed.split('\n').slice(27, 40).join('\n'));
    // Every hunk is inside the selection (lines 28-33, plus the docstring growing).
    for (const hunk of drafts.pending('src/flask/helpers.py')) expect(hunk.oldStart + 1).toBeGreaterThanOrEqual(26);

    const copy = mkdtempSync(path.join(tmpdir(), 'anvil-taskA-'));
    cpSync(path.join(FLASK, 'src'), path.join(copy, 'src'), { recursive: true });
    writeFileSync(path.join(copy, 'src/flask/helpers.py'), proposed);
    const check = (value: string) => execFileSync(PYTHON, ['-c', 'from flask.helpers import get_debug_flag; print(get_debug_flag())'], {
      env: { ...process.env, PYTHONPATH: path.join(copy, 'src'), FLASK_DEBUG: value },
    }).toString().trim();
    expect(check('off')).toBe('False');
    expect(check('N')).toBe('False');
    expect(check('OFF')).toBe('False');
    expect(check('1')).toBe('True');
    expect(check('yes')).toBe('True');
  });
});
