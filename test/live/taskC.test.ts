// Task C, live: the primary model has an invalid key. Anvil must fall back to the next provider
// automatically, still stage the Task A edit, show a clear message, and leave git status clean.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TrueForge } from '@truefoundry/trueforge-sdk';
import { DraftStore } from '../../src/drafts/store';
import { editTools, type EditContext } from '../../src/mcp/editTools';
import { readTools } from '../../src/mcp/readTools';
import { startInlineEdit, withFallback } from '../../src/inline/run';
import type { RecoveryNotice } from '../../src/forge/resilience';
import { FLASK, SERVER, startLive, type Live } from './harness';

const BROKEN = 'broken/llama';
const FALLBACK = process.env.ANVIL_FALLBACK ?? 'ollama/qwen2-5-3b';
const sdk = new TrueForge({ baseUrl: SERVER });
const drafts = new DraftStore();
const real = (p: string) => readFileSync(path.join(FLASK, p), 'utf8').replace(/\r\n/g, '\n');
const edits: EditContext = { drafts, realText: async (p) => real(p), model: () => FALLBACK };
let live: Live;

beforeAll(async () => {
  await sdk.settings.modelProviders.createOrUpdate({ manifest: { type: 'custom', name: 'broken', baseUrl: 'https://api.groq.com/openai/v1',
    auth: { apiKey: 'gsk_this_key_is_invalid' }, models: [{ modelId: 'llama-3.3-70b-versatile', name: 'llama', properties: {} }] } });
  live = await startLive({ tools: (ws) => [...readTools(ws), ...editTools(edits)] });
});
afterAll(async () => {
  await live.close();
  await sdk.settings.modelProviders.delete('broken').catch(() => undefined);
});

describe('Task C (live)', () => {
  it('falls back automatically and keeps the workspace clean', async () => {
    const notices: RecoveryNotice[] = [];
    const started = Date.now();
    const handle = withFallback({
      chain: [BROKEN, FALLBACK],
      onNotice: (n) => notices.push(n),
      start: (model) => startInlineEdit({
        deps: { client: live.client, edits, ensureReady: async () => undefined },
        request: { path: 'src/flask/helpers.py', startLine: 28, endLine: 33, language: 'python', text: real('src/flask/helpers.py'),
          instruction: "Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false." },
        model,
      }),
    });
    const result = await handle.done;
    console.log(notices, result.outcome, `pending=${result.pending}`, `${Math.round((Date.now() - started) / 1000)}s`);
    expect(notices[0]).toMatchObject({ title: 'Switched model', detail: `${BROKEN}: 401 invalid API key. Continuing on ${FALLBACK}. No files were written.` });
    expect(result.pending).toBeGreaterThan(0);
    console.log(drafts.view('src/flask/helpers.py')!.split('\n').slice(27, 38).join('\n'));
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: FLASK }).toString().trim()).toBe('');
  }, 400_000);
});
