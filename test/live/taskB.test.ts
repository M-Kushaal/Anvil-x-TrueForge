// Task B, live: agent mode on Flask with no files named. Checks that 3+ files are staged
// (code, test, docs), the real checkout is untouched, and the proposal passes tests/test_cli.py.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChatController } from '../../src/chat/controller';
import { ContextEngine } from '../../src/context/engine';
import { loadGraph } from '../../src/context/graphify';
import { toContextView } from '../../src/context/view';
import { DraftStore } from '../../src/drafts/store';
import { ForgeClient } from '../../src/forge/client';
import { registerConnector } from '../../src/forge/connector';
import { commandTools, isSafeCommand } from '../../src/mcp/commandTools';
import { contextTools } from '../../src/mcp/contextTools';
import { editTools, validateEdit, EDIT_TOOL_NAMES, type EditContext } from '../../src/mcp/editTools';
import { planTool } from '../../src/mcp/planTool';
import { readTools } from '../../src/mcp/readTools';
import { startMcpServer, type McpHost } from '../../src/mcp/server';
import { limitsFor, specFor } from '../../src/models/limits';
import type { ChatState } from '../../src/shared/protocol';
import { createWorkspace } from '../../src/workspace/workspace';
import { FLASK, SERVER } from './harness';

const TASK_B = 'Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.';
const MODELS = (process.env.ANVIL_MODELS ?? 'groq/gpt-oss-120b,groq-2/gpt-oss-120b,groq/gpt-oss-20b,groq-2/gpt-oss-20b').split(',');
const SETTINGS = { leanProviders: ['groq'], compactAt: Number(process.env.ANVIL_COMPACT ?? 60000), contextBudget: Number(process.env.ANVIL_BUDGET ?? 3000) };
const PYTHON = path.resolve(FLASK, '../.flask-venv/Scripts/python.exe');

const drafts = new DraftStore();
let host: McpHost;
let controller: ChatController;
let state: ChatState | undefined;

beforeAll(async () => {
  const ws = createWorkspace({ root: FLASK, liveText: (abs) => drafts.view(path.relative(FLASK, abs).split(path.sep).join('/')) });
  const engine = new ContextEngine(ws);
  const graph = loadGraph(path.resolve(__dirname, '../../.cache/flask-graph/graph.json'));
  if (graph) engine.setGraph(graph);
  const real = (p: string) => { try { return readFileSync(path.join(FLASK, p), 'utf8').replace(/\r\n/g, '\n'); } catch { return undefined; } };
  const edits: EditContext = { drafts, realText: async (p) => real(p), model: () => state?.model ?? MODELS[0]! };
  host = await startMcpServer({ tools: () => [
    ...readTools(ws), ...contextTools(engine), ...editTools(edits),
    ...commandTools({ ws, drafts, extraPath: () => [path.resolve(FLASK, '../.flask-venv/Scripts')] }),
    planTool((steps) => controller.setPlan(steps)),
  ] });
  const { client, sdk } = ForgeClient.connect(SERVER);
  await registerConnector(sdk, host);
  controller = new ChatController({
    client,
    models: () => MODELS,
    post: (s) => { state = s; },
    ensureReady: async () => undefined,
    onApproval: async ({ name, args }) => {
      if ((EDIT_TOOL_NAMES as readonly string[]).includes(name)) {
        const error = await validateEdit(edits, name, args);
        return error ? { status: 'deny', reason: error } : { status: 'allow' };
      }
      if (name === 'run_command') return isSafeCommand(String(JSON.parse(args).command ?? '')) ? { status: 'allow' } : { status: 'deny', reason: 'not allowed in this test' };
      return { status: 'deny', reason: 'not allowed' };
    },
    specFor: (model) => specFor(model, SETTINGS),
    contextFor: async (prompt) => {
      const pack = await engine.pack(prompt, { budget: limitsFor(MODELS[0]!, SETTINGS).contextBudget });
      return { text: pack.text, view: toContextView(pack, engine) };
    },
  });
  drafts.onChange(() => controller.setChanges(drafts.summary()));
});
afterAll(() => { controller.stop(); host.close(); });

describe('Task B (live)', () => {
  it('stages code, test and docs changes that pass tests/test_cli.py', async () => {
    const t0 = Date.now();
    await controller.send(TASK_B);
    const s = state!;
    const rows = s.items.map((i) => i.kind === 'tool' ? `${i.status.padEnd(7)} ${i.name} ${i.args.slice(0, 80)} · ${i.summary ?? ''}`
      : i.kind === 'notice' ? `NOTICE ${i.title}: ${i.detail}` : i.kind === 'plan' ? `PLAN ${i.steps.map((x) => `[${x.status}] ${x.title}`).join(' | ')}`
      : i.kind === 'text' ? `TEXT ${i.text.slice(0, 200)}` : i.kind);
    console.log(rows.join('\n'));
    console.log('changes:', JSON.stringify(s.changes), `model: ${s.model}`, `${Math.round((Date.now() - t0) / 1000)}s`, `tokens: ${s.lastTurn?.tokens}`);

    const files = s.changes.map((c) => c.path);
    expect(files).toEqual(expect.arrayContaining(['src/flask/cli.py', 'tests/test_cli.py', 'docs/cli.rst']));
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: FLASK }).toString().trim()).toBe('');

    const copy = mkdtempSync(path.join(tmpdir(), 'anvil-taskB-'));
    cpSync(FLASK, copy, { recursive: true, filter: (src) => !/[\\/]\.git$/.test(src) });
    for (const d of drafts.all()) writeFileSync(path.join(copy, d.path), d.proposed);
    const env = { ...process.env, PYTHONPATH: path.join(copy, 'src') };
    const pytest = (() => {
      try { return execFileSync(PYTHON, ['-m', 'pytest', 'tests/test_cli.py', '-q', '-p', 'no:cacheprovider'], { cwd: copy, env }).toString(); }
      catch (e) { return String((e as { stdout?: Buffer }).stdout ?? e); }
    })();
    console.log(pytest.split('\n').slice(-8).join('\n'));
    const help = execFileSync(PYTHON, ['-m', 'flask', '--help'], { cwd: copy, env }).toString();
    console.log(help.split('\n').filter((l) => /config|routes|shell|run/.test(l)).join('\n'));
    expect(help).toMatch(/^\s+config\s/m);
    expect(pytest).toMatch(/\d+ passed/);
    expect(pytest).not.toMatch(/failed|error/i);
  }, 1_200_000);
});
