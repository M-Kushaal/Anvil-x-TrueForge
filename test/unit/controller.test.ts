import { describe, expect, it, vi } from 'vitest';
import { ChatController } from '../../src/chat/controller';
import { ForgeClient, type Decision, type TurnOutcome } from '../../src/forge/client';
import type { ChatState } from '../../src/shared/protocol';
import { fakeForge, type Step } from './fakeForge';

const CHAIN = ['groq/gpt-oss-120b', 'groq/gpt-oss-20b', 'ollama/qwen2.5-coder-3b'];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup(turns: Step[][], options: { chain?: string[] } = {}) {
  const fake = fakeForge(...turns);
  const states: ChatState[] = [];
  const sleeps: number[] = [];
  let clock = 0;
  const controller = new ChatController({
    client: new ForgeClient(fake.api, 'http://localhost:8790'),
    models: () => options.chain ?? ['groq/gpt-oss-120b'],
    post: (s) => states.push(s),
    onApproval: async () => ({ status: 'allow' }),
    ensureReady: async () => undefined,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    now: () => clock,
  });
  return { controller, ...fake, sleeps, last: () => states.at(-1)! };
}

const done = { type: 'turn.done', id: 'd', state: { status: 'done', metrics: { totalTokens: 1234 } } };
const failed = (message: string) => ({ type: 'turn.done', id: 'e', state: { status: 'error', message } });

describe('ChatController', () => {
  it('streams a turn into the timeline and records totals', async () => {
    const { controller, last } = setup([[
      { type: 'turn.created', id: 't', turnId: 'turn1' },
      { type: 'model.message', id: 'm1', threadId: 'main', content: '' },
      { type: 'model.message.delta', id: 'm1', threadId: 'main', content: 'Hello' },
      { type: 'model.message.delta', id: 'm1', threadId: 'main', content: ' world' },
      done,
    ]]);
    await controller.send('hi');
    expect(last().items).toEqual([
      { kind: 'user', id: 'u1', text: 'hi' },
      { kind: 'text', id: 'm1', threadId: 'main', text: 'Hello world' },
    ]);
    expect(last().running).toBe(false);
    expect(last().lastTurn?.tokens).toBe(1234);
    expect(last().title).toBe('hi');
  });

  it('posts approval decisions into the open turn', async () => {
    const call = { id: 'c1', function: { name: 'propose_edit', arguments: '{"path":"a.py"}' }, toolInfo: { name: 'propose_edit' } };
    const { controller, posted } = setup([[
      { type: 'turn.created', id: 't', turnId: 'turn1' },
      { type: 'model.message', id: 'm1', threadId: 'main', toolCalls: [call] },
      { type: 'tool.approval_required', id: 'a', threadId: 'main', toolCalls: [{ id: 'c1', sourceEventId: 'm1' }] },
      done,
    ]]);
    await controller.send('edit');
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({ events: [{ type: 'user.tool_approval', threadId: 'main', toolCallId: 'c1', approval: { status: 'allow' } }] });
  });

  it('stops a streaming turn and says no files were written', async () => {
    const { controller, api, last } = setup([[{ type: 'turn.created', id: 't', turnId: 'turn1' }, 'hang']]);
    const running = controller.send('long task');
    await vi.waitFor(() => expect(api.sessions.createTurnStream).toHaveBeenCalled());
    controller.stop();
    await running;
    expect(api.sessions.cancel).toHaveBeenCalledWith('s1');
    expect(last().items.at(-1)).toMatchObject({ kind: 'notice', title: 'Stopped' });
    expect(last().items.at(-1)).not.toHaveProperty('detail'); // nothing pending: nothing more to say
    expect(last().running).toBe(false);
  });

  it('settles rows the stopped turn left open, so no live Run/Skip or spinner remains', async () => {
    const { controller, api, last } = setup([[
      { type: 'turn.created', id: 't', turnId: 'turn1' },
      { type: 'model.message', id: 'm', toolCalls: [{ id: 'c1', function: { name: 'run_command', arguments: '{"command":"pytest"}' } }] },
      'hang',
    ]]);
    const running = controller.send('run the tests');
    await vi.waitFor(() => expect(api.sessions.createTurnStream).toHaveBeenCalled());
    await vi.waitFor(() => expect(controller.snapshot.items.some((i) => i.kind === 'tool')).toBe(true));
    controller.stop();
    await running;
    expect(last().items.find((i) => i.kind === 'tool')).toMatchObject({ id: 'c1', status: 'stopped' });
  });

  it('notes a model switch only when the run finished, not when it was stopped', async () => {
    const { controller, last } = setup([[failed('[Model Error] Request failed (401): Invalid API Key')], ['hang']], { chain: CHAIN });
    const running = controller.send('x');
    await vi.waitFor(() => expect(controller.snapshot.model).toBe('ollama/qwen2.5-coder-3b'));
    controller.stop();
    await running;
    expect(last().items.some((i) => i.kind === 'notice' && i.title.startsWith('Answered by'))).toBe(false);
  });

  it('honours a stop pressed before the session exists', async () => {
    const { controller, api, last } = setup([[done]]);
    const running = controller.send('long task');
    controller.stop(); // synchronously, before createSession resolves
    await running;
    expect(api.sessions.createTurnStream).not.toHaveBeenCalled();
    expect(last().items.at(-1)).toMatchObject({ title: 'Stopped' });
  });

  it('ignores sends while a turn is running and reuses the session', async () => {
    const { controller, api } = setup([[done]]);
    await controller.send('one');
    await controller.send('two');
    expect(api.sessions.create).toHaveBeenCalledTimes(1);
    expect(api.sessions.createTurnStream).toHaveBeenCalledTimes(2);
  });

  it.each(['newChat', 'resume'] as const)('ignores a late session creation after %s', async (action) => {
    const { controller, api } = setup([[done]]);
    const created = deferred<{ data: { id: string } }>();
    vi.mocked(api.sessions.create).mockReturnValueOnce(created.promise);
    const pending = controller.send('old task');
    await vi.waitFor(() => expect(api.sessions.create).toHaveBeenCalledOnce());
    if (action === 'newChat') controller.newChat();
    else controller.resume({ sessionId: 'resumed', title: 'Earlier task', items: [] });
    created.resolve({ data: { id: 'abandoned' } });
    await pending;
    expect(controller.currentSession).toBe(action === 'resume' ? 'resumed' : undefined);
    expect(api.sessions.cancel).toHaveBeenCalledWith('abandoned');
    expect(api.sessions.createTurnStream).not.toHaveBeenCalled();
    expect(controller.snapshot.running).toBe(false);
  });

  it('denies late approvals without prompting after the task was replaced', async () => {
    const fake = fakeForge([done]);
    const client = new ForgeClient(fake.api, 'x');
    const turn = deferred<TurnOutcome>();
    let request!: Parameters<ForgeClient['runTurn']>[0];
    vi.spyOn(client, 'runTurn').mockImplementation((args) => { request = args; return turn.promise; });
    const onApproval = vi.fn(async (): Promise<Decision> => ({ status: 'allow' }));
    const controller = new ChatController({ client, models: () => ['m'], post: () => undefined, onApproval, ensureReady: async () => undefined });
    const pending = controller.send('old task');
    await vi.waitFor(() => expect(client.runTurn).toHaveBeenCalledOnce());
    controller.newChat();
    expect(await request.handlers.onApproval({ toolCallId: 'c', threadId: 'main', name: 'run_command', args: '{"command":"npm test"}' })).toMatchObject({ status: 'deny' });
    expect(onApproval).not.toHaveBeenCalled();
    turn.resolve({ status: 'cancelled' });
    await pending;
  });

  it('denies an outstanding approval if its task stops before the decision returns', async () => {
    const fake = fakeForge([done]);
    const client = new ForgeClient(fake.api, 'x');
    const turn = deferred<TurnOutcome>();
    const decision = deferred<Decision>();
    let request!: Parameters<ForgeClient['runTurn']>[0];
    vi.spyOn(client, 'runTurn').mockImplementation((args) => { request = args; return turn.promise; });
    const onApproval = vi.fn(() => decision.promise);
    const controller = new ChatController({ client, models: () => ['m'], post: () => undefined, onApproval, ensureReady: async () => undefined });
    const pending = controller.send('old task');
    await vi.waitFor(() => expect(client.runTurn).toHaveBeenCalledOnce());
    const approval = request.handlers.onApproval({ toolCallId: 'c', threadId: 'main', name: 'run_command', args: '{"command":"npm test"}' });
    controller.stop();
    decision.resolve({ status: 'allow' });
    expect(await approval).toMatchObject({ status: 'deny' });
    turn.resolve({ status: 'cancelled' });
    await pending;
  });
});

describe('ChatController resilience', () => {
  it('switches to the next provider after a rejected key and finishes the request', async () => {
    const { controller, api, updates, last } = setup([[failed('[Model Error] Request failed (401): Invalid API Key')], [done]], { chain: CHAIN });
    await controller.send('add a test');
    // Skips groq/gpt-oss-20b: the same key would fail again.
    expect(JSON.stringify(updates[0])).toContain('"ollama/qwen2.5-coder-3b"');
    expect(api.sessions.createTurnStream).toHaveBeenCalledTimes(2);
    expect(last().model).toBe('ollama/qwen2.5-coder-3b');
    // The live switch stays visible, followed by the model that completed the response.
    const notices = last().items.filter((i) => i.kind === 'notice');
    expect(notices).toEqual([{ kind: 'notice', id: expect.any(String), level: 'info', title: 'Switching to ollama/qwen2.5-coder-3b',
      detail: 'groq/gpt-oss-120b: 401 invalid API key' },
    { kind: 'notice', id: expect.any(String), level: 'info', title: 'Answered by ollama/qwen2.5-coder-3b',
      detail: 'groq/gpt-oss-120b: 401 invalid API key' }]);
    expect(last().activity).toBeUndefined();
  });

  it('waits out a rate limit and asks the agent to continue', async () => {
    const { controller, api, sleeps } = setup([
      [{ type: 'model.message', id: 'm', content: 'working' }, failed('[Model Error] Request failed (429): Please try again in 12.5s.')],
      [done],
    ], { chain: CHAIN });
    await controller.send('big task');
    expect(sleeps).toEqual([13_000]);
    const second = (api.sessions.createTurnStream as ReturnType<typeof vi.fn>).mock.calls[1]![1] as { input: Array<{ content: string }> };
    expect(second.input[0]!.content).toMatch(/^Continue the task from where you stopped/);
  });

  it('alternates between two accounts on rate limits for as long as the turn makes progress', async () => {
    const keys = ['groq/gpt-oss-120b', 'groq-2/gpt-oss-120b'];
    const limited = () => [{ type: 'model.message', id: 'm', content: 'step' }, failed('Request failed (429): Please try again in 20s.')];
    const { controller, last, sleeps } = setup([...Array.from({ length: 14 }, limited), [done]], { chain: keys });
    await controller.send('long task');
    // First hop is free; then each wait is spent on whichever account frees up first, never both.
    expect(sleeps[0]).toBe(0);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThan(14 * 20_500);
    expect(last().items.some((i) => i.kind === 'notice' && i.title === 'No model reachable')).toBe(false);
    expect(last().running).toBe(false);
  });

  it('asks the agent to continue when it stops with its plan unfinished, at most three times', async () => {
    const { controller, api } = setup([[done]]);
    const run = controller.send('add a command');
    controller.setPlan([{ title: 'Add command', status: 'done' }, { title: 'Add test', status: 'todo' }]);
    await run;
    const calls = (api.sessions.createTurnStream as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(4);
    expect((calls[1]![1] as { input: Array<{ content: string }> }).input[0]!.content).toContain('Unfinished steps of your plan: Add test.');
  });

  it('does not nudge when the plan is finished', async () => {
    const { controller, api } = setup([[done]]);
    const run = controller.send('add a command');
    controller.setPlan([{ title: 'Add command', status: 'done' }]);
    await run;
    expect(api.sessions.createTurnStream).toHaveBeenCalledTimes(1);
  });

  it('starts a fresh session with the task and staged progress when the history outgrows the request limit', async () => {
    const tooLarge = failed('[Model Error] Request failed (413): Request too large for model `openai/gpt-oss-120b`: Limit 8000, Requested 9374');
    const { controller, api, created, last } = setup([[{ type: 'model.message', id: 'm', content: 'editing' }, tooLarge], [done]], { chain: ['groq/gpt-oss-120b'] });
    const run = controller.send('add a config command');
    controller.setChanges([{ path: 'src/flask/cli.py', added: 20, removed: 0, hunks: 2, isNew: false }]);
    controller.setPlan([{ title: 'Add command', status: 'done' }, { title: 'Document it', status: 'todo' }]);
    await run;
    expect(created).toHaveLength(2);
    const second = (api.sessions.createTurnStream as ReturnType<typeof vi.fn>).mock.calls[1]!;
    expect(second[0]).toBe('s2');
    const content = (second[1] as { input: Array<{ content: string }> }).input[0]!.content;
    expect(content).toMatch(/^add a config command/);
    expect(content).toContain('Already staged, do not redo: src/flask/cli.py (+20 −0)');
    expect(content).toContain('Plan steps not done yet: Document it');
    expect(last().items.some((i) => i.kind === 'notice' && i.level === 'warn')).toBe(false); // recovery is not a card
  });

  it('sends no context pack with a greeting', async () => {
    const contextFor = vi.fn(async () => ({ text: 'pack', view: { used: 1, budget: 1, items: [], dropped: [], source: '' } }));
    const fake = fakeForge([done]);
    const controller = new ChatController({
      client: new ForgeClient(fake.api, 'http://localhost:8790'), models: () => ['m'], post: () => undefined,
      onApproval: async () => ({ status: 'allow' }), ensureReady: async () => undefined, contextFor,
    });
    await controller.send('hi');
    expect(contextFor).not.toHaveBeenCalled();
    await controller.send('add a config command');
    expect(contextFor).toHaveBeenCalledOnce();
  });

  it('saves the chat after each turn and resumes it on the same session', async () => {
    const saved: Array<{ sessionId: string; title: string }> = [];
    const fake = fakeForge([done]);
    const controller = new ChatController({
      client: new ForgeClient(fake.api, 'http://localhost:8790'), models: () => ['m'], post: () => undefined,
      onApproval: async () => ({ status: 'allow' }), ensureReady: async () => undefined,
      onTurnEnd: (sessionId, state) => saved.push({ sessionId, title: state.title }),
    });
    await controller.send('explain the cli');
    expect(saved).toEqual([{ sessionId: 's1', title: 'explain the cli' }]);
    const items = controller.snapshot.items;
    controller.newChat();
    expect(controller.currentSession).toBeUndefined();
    controller.resume({ sessionId: 's1', title: 'explain the cli', items });
    expect(controller.currentSession).toBe('s1');
    expect(controller.snapshot.items).toEqual(items);
    await controller.send('and the tests?');
    expect(fake.created).toHaveLength(1); // no new session: the old one continues
    expect(new Set(controller.snapshot.items.map((i) => i.id)).size).toBe(controller.snapshot.items.length);
  });

  it('reports once when every model fails', async () => {
    const { controller, last } = setup([[failed('Cannot connect to API: bad port')]], { chain: ['ollama/qwen2.5-coder-3b'] });
    await controller.send('hi');
    const notices = last().items.filter((i) => i.kind === 'notice');
    expect(notices.map((n) => n.kind === 'notice' && n.title)).toEqual(['No model reachable']); // retries were working-bar lines
  });

  it('cuts a long rate-limit wait short when the user stops', async () => {
    const fake = fakeForge([failed('Request failed (429): Please try again in 60s.')], [done]);
    const controller = new ChatController({
      client: new ForgeClient(fake.api, 'x'), models: () => ['m'], post: () => undefined,
      onApproval: async () => ({ status: 'allow' }), ensureReady: async () => undefined,
      sleep: () => new Promise<void>(() => undefined), // a wait that never ends by itself
    });
    const running = controller.send('x');
    await vi.waitFor(() => expect(controller.snapshot.activity).toMatch(/Retrying/));
    controller.stop();
    await running;
    expect(controller.snapshot.running).toBe(false);
    expect(fake.api.sessions.createTurnStream).toHaveBeenCalledTimes(1);
  });

  it('ignores a replaced turn: New chat mid-run keeps the old stream out of the new chat', async () => {
    const saved: string[] = [];
    const fake = fakeForge([{ type: 'model.message', id: 'm1', content: 'old answer' }, 'hang']);
    const controller = new ChatController({
      client: new ForgeClient(fake.api, 'x'), models: () => ['m'], post: () => undefined,
      onApproval: async () => ({ status: 'allow' }), ensureReady: async () => undefined,
      onTurnEnd: (sessionId) => saved.push(sessionId),
    });
    const running = controller.send('first question');
    await vi.waitFor(() => expect(controller.snapshot.items.some((i) => i.kind === 'text')).toBe(true));
    controller.newChat();
    await running;
    expect(controller.snapshot.items).toEqual([]);
    expect(controller.snapshot.running).toBe(false);
    expect(saved).toEqual([]); // the abandoned turn is not saved under any session
  });

  it('stops during a retry wait', async () => {
    const fake = fakeForge([failed('(503) Service Unavailable')], [done]);
    let release: () => void = () => undefined;
    const controller = new ChatController({
      client: new ForgeClient(fake.api, 'x'),
      models: () => CHAIN,
      post: () => undefined,
      onApproval: async () => ({ status: 'allow' }),
      ensureReady: async () => undefined,
      sleep: () => new Promise<void>((r) => { release = r; }),
    });
    const running = controller.send('x');
    await vi.waitFor(() => expect(controller.snapshot.activity).toMatch(/Retrying/));
    controller.stop();
    release();
    await running;
    expect(fake.api.sessions.createTurnStream).toHaveBeenCalledTimes(1);
    expect(controller.snapshot.items.at(-1)).toMatchObject({ title: 'Stopped' });
  });
});
