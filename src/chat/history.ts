// Saved chats: each finished turn stores the chat's timeline and its TrueForge session, so an earlier
// chat can be reopened and continued. Lives in the workspace's storage (a Memento, passed in).
import type { ChatState, TimelineItem } from '../shared/protocol';
import type { Store } from '../inline/history';

export interface SavedChat {
  changeSetId?: string;
  sessionId: string;
  title: string;
  at: number;
  model: string;
  items: TimelineItem[];
}

const KEY = 'anvil.chats';
const LIMIT = 40;

export class ChatHistory {
  constructor(private readonly store: Store) {}

  list(): SavedChat[] {
    return this.store.get<SavedChat[]>(KEY) ?? [];
  }

  get(sessionId: string): SavedChat | undefined {
    return this.list().find((c) => c.sessionId === sessionId);
  }

  /** Saves (or updates) a chat; the most recent comes first. */
  async save(sessionId: string, state: ChatState): Promise<void> {
    if (!state.items.some((i) => i.kind === 'user')) return;
    const chat: SavedChat = { sessionId, changeSetId: state.changeSetId, title: state.title, at: Date.now(), model: state.model, items: state.items };
    await this.store.update(KEY, [chat, ...this.list().filter((c) => c.sessionId !== sessionId)].slice(0, LIMIT));
  }

  async remove(sessionId: string): Promise<void> {
    await this.store.update(KEY, this.list().filter((c) => c.sessionId !== sessionId));
  }
}
