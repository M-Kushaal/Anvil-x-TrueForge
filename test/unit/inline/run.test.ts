import { describe, expect, it } from 'vitest';
import { ForgeClient } from '../../../src/forge/client';
import { DraftStore } from '../../../src/drafts/store';
import type { EditContext } from '../../../src/mcp/editTools';
import { startInlineEdit } from '../../../src/inline/run';
import { fakeForge } from '../../support/fakeForge';

const text = 'def f():\n    return 1\n\n\ndef g():\n    return 2\n';

function setup(script: Array<object | 'hang'>) {
  const { api, posted, created } = fakeForge(script);
  const drafts = new DraftStore();
  const edits: EditContext = { drafts, realText: async () => text, model: () => 'm' };
  const start = () => startInlineEdit({
    deps: { client: new ForgeClient(api, 'http://x'), edits, ensureReady: async () => undefined },
    request: { path: 'a.py', startLine: 1, endLine: 2, instruction: 'return 10', text, language: 'python' },
    model: 'm',
  });
  return { api, posted, created, drafts, edits, start };
}

const call = (args: object) => ({ id: 'c1', function: { name: 'propose_edit', arguments: JSON.stringify(args) }, toolInfo: { name: 'propose_edit' } });

describe('inline edit run', () => {
  it('ends the turn as soon as the edit is staged', async () => {
    const { api, drafts, start } = setup([
      { type: 'turn.created', id: 't', turnId: 'tu1' },
      { type: 'tool.response', id: 'r', toolCallId: 'c1', content: 'a.py · pending +1 −1' },
      'hang',
    ]);
    drafts.stage({ path: 'a.py', search: '    return 1', replace: '    return 10', model: 'm' }, text);
    const result = await start().done;
    expect(api.sessions.cancel).toHaveBeenCalled();
    expect(result.outcome.status).toBe('done');
    expect(result.pending).toBe(1);
  });

  it('runs with only read_file and propose_edit, no subagents', async () => {
    const { created, start } = setup([{ type: 'turn.done', id: 'd', state: { status: 'done' } }]);
    await start().done;
    const spec = (created[0] as { agent: { spec: { mcpServers: Array<{ enableTools: string[] }>; config: { dynamicSubAgents: { enabled: boolean } } } } }).agent.spec;
    expect(spec.mcpServers[0]!.enableTools).toEqual(['read_file', 'propose_edit']);
    expect(spec.config.dynamicSubAgents.enabled).toBe(false);
  });

  it('denies an edit outside the selection at the approval gate', async () => {
    const { posted, start } = setup([
      { type: 'turn.created', id: 't', turnId: 'tu1' },
      { type: 'model.message', id: 'm1', toolCalls: [call({ path: 'a.py', search: '    return 2', replace: '    return 20' })] },
      { type: 'tool.approval_required', id: 'a', threadId: 'main', toolCalls: [{ id: 'c1', sourceEventId: 'm1' }] },
      { type: 'turn.done', id: 'd', state: { status: 'done' } },
    ]);
    await start().done;
    await new Promise((r) => setTimeout(r, 10));
    expect(JSON.stringify(posted[0])).toContain('outside the user');
    expect(JSON.stringify(posted[0])).toContain('"deny"');
  });

  it('cancel before the session starts leaves nothing staged', async () => {
    const { drafts, start } = setup(['hang']);
    const handle = start();
    handle.cancel();
    const result = await handle.done;
    expect(result.outcome.status).toBe('cancelled');
    expect(drafts.all()).toHaveLength(0);
  });
});
