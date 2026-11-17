import { describe, expect, it } from 'vitest';
import { applyEvent, describeCall, firstLine, initialState, type ForgeEvent } from '../../../src/forge/timeline';
import { toolLabel } from '../../../src/shared/labels';

const run = (events: ForgeEvent[]) => events.reduce(applyEvent, initialState('groq/gpt-oss-120b'));
const call = (id: string, name: string, args: object) => ({ id, function: { name, arguments: JSON.stringify(args) }, toolInfo: { name } });

describe('timeline reducer', () => {
  it('turns a tool call and its response into one row', () => {
    const state = run([
      { type: 'model.message', id: 'm1', threadId: 'main', content: '', toolCalls: [call('c1', 'read_file', { path: 'a.py' })] },
      { type: 'tool.response', id: 'r1', threadId: 'main', toolCallId: 'c1', content: 'a.py · lines 1–10 of 10\n1│x' },
    ]);
    expect(state.items).toEqual([
      { kind: 'tool', id: 'c1', threadId: 'main', name: 'read_file', args: '{"path":"a.py"}', status: 'done', summary: 'a.py · lines 1–10 of 10', output: 'a.py · lines 1–10 of 10\n1│x' },
    ]);
  });

  it('updates streamed text in place', () => {
    const state = run([
      { type: 'model.message', id: 'm1', content: 'Hel' },
      { type: 'model.message', id: 'm1', content: 'Hello' },
    ]);
    expect(state.items).toEqual([{ kind: 'text', id: 'm1', threadId: 'main', text: 'Hello' }]);
  });

  it('marks gated calls as waiting, then done after the response', () => {
    const base: ForgeEvent[] = [
      { type: 'model.message', id: 'm1', toolCalls: [call('c1', 'propose_edit', { path: 'a.py' })] },
      { type: 'tool.approval_required', id: 'a1', toolCalls: [{ id: 'c1', sourceEventId: 'm1' }] },
    ];
    expect(run(base).items[0]).toMatchObject({ status: 'waiting' });
    // A re-emitted (merged) model.message must not reset the status.
    expect(run([...base, base[0]!]).items[0]).toMatchObject({ status: 'waiting' });
    expect(run([...base, { type: 'tool.response', id: 'r', toolCallId: 'c1', content: 'staged' }]).items[0]).toMatchObject({ status: 'done' });
  });

  it('flags error results', () => {
    const state = run([
      { type: 'model.message', id: 'm1', toolCalls: [call('c1', 'read_file', { path: 'x' })] },
      { type: 'tool.response', id: 'r', toolCallId: 'c1', content: 'Error: file not found: x' },
    ]);
    expect(state.items[0]).toMatchObject({ status: 'error', summary: 'Error: file not found: x' });
  });

  it.each([
    ['npm test · exit 0 · 1s\nall tests passed', 'done'],
    ['npm test · exit 3 · 1s\nassertion failed at test.ts:12', 'error'],
    ['npm test · exit killed · cancelled\npartial output', 'error'],
    ['npm test · exit null · timed out\npartial output', 'error'],
    [`Error: ${'long-command '.repeat(20)} · exit 3\nfailure details`, 'error'],
  ])('retains command output and classifies outcome: %s', (output, status) => {
    const state = run([
      { type: 'model.message', id: 'm', toolCalls: [call('c', 'run_command', { command: 'npm test' })] },
      { type: 'tool.response', id: 'r', toolCallId: 'c', content: [{ type: 'text', text: output }] },
    ]);
    expect(state.items[0]).toMatchObject({ status, output });
  });

  it('bounds retained tool output without losing the final diagnostic', () => {
    const output = `npm test · exit 0\n${'x'.repeat(80_000)}\nfinal diagnostic`;
    const state = run([
      { type: 'model.message', id: 'm', toolCalls: [call('c', 'run_command', { command: 'npm test' })] },
      { type: 'tool.response', id: 'r', toolCallId: 'c', content: output },
    ]);
    const item = state.items[0];
    expect(item?.kind).toBe('tool');
    if (item?.kind !== 'tool') return;
    expect(item.output?.length).toBeLessThanOrEqual(65_536);
    expect(item.output?.endsWith('final diagnostic')).toBe(true);
    expect(item.summary).toBe('npm test · exit 0');
  });

  it('hides harness plumbing and shows subagents as thread rows', () => {
    const state = run([
      { type: 'model.message', id: 'm1', toolCalls: [call('c1', 'create_sub_agent', {})] },
      { type: 'thread.created', id: 't', threadId: 'th1', title: 'Explorer' },
      { type: 'thread.done', id: 'td', threadId: 'th1', state: { status: 'done' } },
    ]);
    expect(state.items).toEqual([{ kind: 'thread', id: 'th1', title: 'Explorer', status: 'done' }]);
  });
});

describe('describeCall', () => {
  it('unwraps deferred call_tool invocations', () => {
    const c = call('c1', 'call_tool', { server_name: 'anvil-editor', tool_name: 'read_file', arguments: { path: 'a.py' } });
    expect(describeCall(c)).toEqual({ name: 'read_file', args: '{"path":"a.py"}' });
  });
});

describe('firstLine', () => {
  it('reads MCP content arrays and JSON-encoded content', () => {
    expect(firstLine([{ type: 'text', text: '\nsummary\nmore' }])).toBe('summary');
    expect(firstLine(JSON.stringify([{ type: 'text', text: 'hello\nworld' }]))).toBe('hello');
  });
});

describe('toolLabel', () => {
  it('names the verb and the target', () => {
    expect(toolLabel('read_file', '{"path":"src/cli.py"}')).toEqual({ verb: 'Read', target: 'src/cli.py' });
    expect(toolLabel('search_code', '{"query":"add_command"}')).toEqual({ verb: 'Searched', target: '"add_command"' });
  });

  it('copes with partial JSON and unknown tools', () => {
    expect(toolLabel('read_file', '{"pa')).toEqual({ verb: 'Read', target: '' });
    expect(toolLabel('web_search', '{}')).toEqual({ verb: 'Web search', target: '' });
  });
});
