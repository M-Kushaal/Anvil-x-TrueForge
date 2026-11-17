import { describe, expect, it, vi } from 'vitest';
import { ChatHistory } from '../../../src/chat/history';
import { InlineHistory, inlineSession, type Store } from '../../../src/inline/history';
import type { ForgeClient } from '../../../src/forge/client';
import type { ChatState } from '../../../src/shared/protocol';

function memory(): Store {
  const data = new Map<string, unknown>();
  return { get: <T>(key: string) => data.get(key) as T | undefined, update: async (key, value) => { data.set(key, value); } };
}

const chat = (title: string): ChatState => ({ title, items: [{ kind: 'user', id: 'u1', text: title }], running: false, model: 'm', changes: [] });

describe('ChatHistory', () => {
  it('keeps the newest chat first and updates a chat in place', async () => {
    const chats = new ChatHistory(memory());
    await chats.save('s1', chat('first'));
    await chats.save('s2', chat('second'));
    await chats.save('s1', chat('first, again'));
    expect(chats.list().map((c) => [c.sessionId, c.title])).toEqual([['s1', 'first, again'], ['s2', 'second']]);
  });

  it('does not save a chat with no messages', async () => {
    const chats = new ChatHistory(memory());
    await chats.save('s1', { ...chat('x'), items: [] });
    expect(chats.list()).toEqual([]);
  });
});

describe('InlineHistory', () => {
  it('records an edit and its outcome', async () => {
    const history = new InlineHistory(memory());
    await history.add({ id: 'i1', at: 1, path: 'a.py', startLine: 2, endLine: 4, instruction: 'rename', model: 'm', status: 'running' });
    await history.finish('i1', 'staged');
    expect(history.entries()).toEqual([expect.objectContaining({ id: 'i1', status: 'staged' })]);
  });
});

describe('inlineSession', () => {
  const client = (setSpec: () => Promise<void>) => ({ setSpec: vi.fn(setSpec), createSession: vi.fn(async () => 'new') }) as unknown as ForgeClient;

  it('reuses the shared session, replacing its spec', async () => {
    const history = new InlineHistory(memory());
    await history.setSession('shared');
    const c = client(async () => undefined);
    expect(await inlineSession(c, history, {})).toBe('shared');
    expect(c.createSession).not.toHaveBeenCalled();
  });

  it('starts a new shared session when the old one is gone', async () => {
    const history = new InlineHistory(memory());
    await history.setSession('deleted');
    const c = client(async () => { throw new Error('404'); });
    expect(await inlineSession(c, history, {})).toBe('new');
    expect(history.session()).toBe('new');
  });
});

describe('shared inline session lifetime', () => {
  const client = () => ({ setSpec: vi.fn(async () => undefined), createSession: vi.fn(async () => `s${Math.random()}`) }) as unknown as ForgeClient;

  it('starts a new session after six edits, so old turns never crowd a small model', async () => {
    const history = new InlineHistory(memory());
    const c = client();
    const first = await inlineSession(c, history, {});
    const ids = [];
    for (let i = 0; i < 7; i++) ids.push(await inlineSession(c, history, {}));
    expect(ids.slice(0, 6).every((id) => id === first)).toBe(true);
    expect(ids[6]).not.toBe(first);
  });

  it('forgets the session after an oversized request', async () => {
    const history = new InlineHistory(memory());
    await history.setSession('big');
    await history.resetSession();
    expect(history.session()).toBeUndefined();
  });
});
