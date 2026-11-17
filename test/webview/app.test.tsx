// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/preact';
import { App } from '../../webview/main';
import type { ChatState } from '../../src/shared/protocol';
import { send } from '../../webview/host';

vi.mock('../../webview/host', () => ({ send: vi.fn() }));

const base: ChatState = { title: 'Add a command', items: [], running: false, model: 'groq/gpt-oss-120b', changes: [] };

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('chat webview', () => {
  it('shows the empty state with suggestions and shortcuts', () => {
    const view = render(<App initial={base} />);
    expect(view.getByText('Anvil')).toBeTruthy();
    expect(view.getByText('Explain how this project is structured')).toBeTruthy();
    expect(view.getByText('Ctrl+I')).toBeTruthy();
  });

  it('renders the timeline: user message, tool row with summary, notice', () => {
    const state: ChatState = {
      ...base,
      items: [
        { kind: 'user', id: 'u1', text: 'Add a config command' },
        { kind: 'tool', id: 'c1', threadId: 'main', name: 'read_file', args: '{"path":"src/flask/cli.py"}', status: 'done', summary: 'src/flask/cli.py · lines 1–100 of 1120' },
        { kind: 'text', id: 'm1', threadId: 'main', text: 'Done. Added **config**.' },
        { kind: 'notice', id: 'n1', level: 'info', title: 'Stopped', detail: '2 changes waiting for review.' },
      ],
      lastTurn: { tokens: 12400, ms: 38000 },
    };
    const view = render(<App initial={state} />);
    expect(view.getByText('Read')).toBeTruthy();
    expect(view.getByText('src/flask/cli.py')).toBeTruthy();
    expect(view.getByText('· lines 1–100 of 1120')).toBeTruthy(); // path not repeated
    expect(view.container.querySelector('.prose strong')?.textContent).toBe('config');
    expect(view.getByText('2 changes waiting for review.')).toBeTruthy();
    expect(view.getByText('12.4k tokens in 38s')).toBeTruthy();
  });

  it('nests subagent work under its thread row', () => {
    const state: ChatState = {
      ...base,
      items: [
        { kind: 'thread', id: 't1', title: 'Explorer', status: 'running' },
        { kind: 'tool', id: 'c1', threadId: 't1', name: 'search_code', args: '{"query":"add_command"}', status: 'running' },
      ],
    };
    const view = render(<App initial={state} />);
    expect(view.container.querySelector('.thread')?.textContent).toContain('"add_command"');
  });

  it('swaps send for stop while running and shows the working bar', () => {
    const view = render(<App initial={{ ...base, running: true, startedAt: Date.now(), items: [{ kind: 'user', id: 'u', text: 'hi' }] }} />);
    expect(view.getByLabelText('Stop (Esc)')).toBeTruthy();
    expect(view.container.querySelector('.working')?.textContent).toContain('Working');
  });

  it('shows pending changes with totals and review actions', () => {
    const view = render(<App initial={{ ...base, changes: [
      { path: 'src/flask/cli.py', added: 31, removed: 0, hunks: 2, isNew: false },
      { path: 'docs/cli.rst', added: 5, removed: 1, hunks: 1, isNew: false },
    ] }} />);
    const card = view.getByLabelText('Pending changes');
    expect(card.textContent).toContain('2 files to review');
    expect(card.textContent).toContain('+36');
    expect(card.textContent).toContain('3 changes waiting, nothing written yet');
    expect(view.getByText('Keep all')).toBeTruthy();
  });

  it('asks for a command on its own row, and shows the retry line in the working bar', () => {
    const view = render(<App initial={{
      ...base, running: true, startedAt: Date.now(), activity: 'groq/gpt-oss-120b: 429 rate limited. Retrying in 11s.',
      items: [{ kind: 'tool', id: 't1', threadId: 'main', name: 'run_command', args: '{"command":"pytest -q"}', status: 'waiting' }],
    }} />);
    expect(view.getByRole('group', { name: 'Approve command' })).toBeTruthy();
    expect(view.getByText('Run')).toBeTruthy();
    expect(view.getByText('Skip')).toBeTruthy();
    expect(view.container.querySelector('.working')?.textContent).toContain('Retrying in 11s');
    expect(view.container.querySelectorAll('.notice')).toHaveLength(0); // no card per retry
  });

  it('says when TrueForge is unreachable before anything is sent, with a retry', () => {
    const view = render(<App initial={{ ...base, connection: { ok: false, message: "Can't reach TrueForge at http://localhost:8790." } }} />);
    expect(view.getByRole('alert').textContent).toContain("Can't reach TrueForge");
    expect(view.getByText('Retry')).toBeTruthy();
  });

  it('holds Keep all until the run finishes', () => {
    const changes = [{ path: 'a.py', added: 1, removed: 0, hunks: 1, isNew: false }];
    const running = render(<App initial={{ ...base, running: true, startedAt: Date.now(), changes }} />);
    expect((running.getByText('Keep all') as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    const idle = render(<App initial={{ ...base, changes }} />);
    expect((idle.getByText('Keep all') as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows the context sent with a request: budget, roles, reasons, left-out files', () => {
    const view = render(<App initial={{ ...base, items: [
      { kind: 'user', id: 'u', text: 'Add a config command' },
      { kind: 'context', id: 'c', context: {
        used: 2610, budget: 3000, source: 'Graphify code graph, 212 files indexed',
        items: [{ kind: 'impl', path: 'src/flask/cli.py', tokens: 1240, reasons: ['defines run_command, shell_command'] }],
        dropped: [{ path: 'src/flask/config.py', reason: 'matches only "config"' }],
      } },
    ] }} />);
    const card = view.getByLabelText('Context sent with this request');
    expect(card.textContent).toContain('2.6k / 3.0k tokens');
    expect(card.textContent).toContain('Implementation');
    expect(card.textContent).toContain('defines run_command, shell_command');
    expect(card.textContent).not.toContain('config.py'); // collapsed until asked
    fireEvent.click(view.getByText('Not included (1)'));
    expect(card.textContent).toContain('matches only "config"');
  });

  it('fills the composer when a suggestion is picked', async () => {
    const view = render(<App initial={base} />);
    fireEvent.click(view.getByText('Find where configuration is loaded'));
    await Promise.resolve();
    expect((view.getByLabelText('Message Anvil') as HTMLTextAreaElement).value).toBe('Find where configuration is loaded');
  });

  it('shows failed verification with the complete retained command output', () => {
    const output = 'FAILED tests/test_cli.py::test_config\nExpected a masked key\nassert actual == expected';
    const view = render(<App initial={{ ...base, verification: {
      command: 'python -m pytest tests/test_cli.py -q', code: 1, output,
      status: 'failed', at: 1, snapshotId: 'proposal-1',
    } }} />);
    expect(view.getByText('Last command failed')).toBeTruthy();
    expect(view.getByText('exit 1')).toBeTruthy();
    expect(view.getByLabelText('Command output').textContent).toBe(output);
    expect(view.container.querySelector('.verification.failed')).toBeTruthy();
  });

  it('marks an outdated successful command as needing fresh checks', () => {
    const view = render(<App initial={{ ...base, verification: {
      command: 'npm test', code: 0, output: '12 passed', status: 'outdated', at: 1, snapshotId: 'old',
    } }} />);
    expect(view.container.querySelector('.verification.outdated')?.textContent).toContain('run checks again');
    expect(view.queryByText('Last command passed')).toBeNull();
  });

  it('retains tool-result details separately from arguments', () => {
    const output = 'Error: npm test · exit 1\nFAIL test/command.test.ts\nExpected true, received false';
    const view = render(<App initial={{ ...base, items: [{
      kind: 'tool', id: 'command-1', threadId: 'main', name: 'run_command',
      args: JSON.stringify({ command: 'npm test' }), status: 'error', summary: 'Error: npm test · exit 1', output,
    }] }} />);
    const row = view.container.querySelector('.row.clickable');
    expect(row).toBeTruthy();
    fireEvent.click(row!);
    expect(view.getByText('Arguments')).toBeTruthy();
    expect(view.getByText('Result')).toBeTruthy();
    expect(view.container.querySelector('.row-detail pre:last-child')?.textContent).toBe(output);
  });

  it('shows the complete command before approval even when its label is shortened', () => {
    const command = `python -m pytest tests/${'long_directory_name/'.repeat(6)}test_cli.py -q --disable-warnings`;
    const view = render(<App initial={{ ...base, items: [{
      kind: 'tool', id: 'command-long', threadId: 'main', name: 'run_command',
      args: JSON.stringify({ command }), status: 'waiting',
    }] }} />);
    const approval = view.getByRole('group', { name: 'Approve command' });
    expect(approval.querySelector('pre')?.textContent).toBe(command);
    fireEvent.click(view.getByText('Run'));
    expect(send).toHaveBeenCalledWith({ type: 'approve', id: 'command-long', allow: true });
  });

  it('lets the user remove pinned files and restore excluded context', () => {
    const view = render(<App initial={{ ...base,
      contextFiles: ['src/app.py'], contextExcluded: ['docs/config.md'],
    }} />);
    const pinned = view.getByLabelText('Pinned context files');
    const excluded = view.getByLabelText('Excluded from initial context');
    expect(pinned.textContent).toContain('src/app.py');
    expect(excluded.textContent).toContain('docs/config.md');
    fireEvent.click(pinned.querySelector('button')!);
    expect(send).toHaveBeenCalledWith({ type: 'removeContext', path: 'src/app.py' });
    fireEvent.click(excluded.querySelector('button')!);
    expect(send).toHaveBeenCalledWith({ type: 'restoreContext', path: 'docs/config.md' });
  });

  it('offers pin and exclude actions for a selected context file', () => {
    const view = render(<App initial={{ ...base, items: [{ kind: 'context', id: 'ctx', context: {
      used: 100, budget: 3000, source: 'keyword index', dropped: [],
      items: [{ kind: 'impl', path: 'src/app.py', tokens: 100, reasons: ['matches app'] }],
    } }] }} />);
    fireEvent.click(view.getByText('Pin'));
    expect(send).toHaveBeenCalledWith({ type: 'pinContext', path: 'src/app.py' });
    fireEvent.click(view.getByText('Exclude'));
    expect(send).toHaveBeenCalledWith({ type: 'excludeContext', path: 'src/app.py' });
  });

  it('offers checkpoint recovery even when no proposals are currently pending', () => {
    const view = render(<App initial={{ ...base, changes: [], checkpointAvailable: true }} />);
    expect(view.getByLabelText('Proposal checkpoint')).toBeTruthy();
    expect(view.queryByLabelText('Pending changes')).toBeNull();
    fireEvent.click(view.getByText('Restore checkpoint'));
    expect(send).toHaveBeenCalledWith({ type: 'restoreCheckpoint' });
  });
});
