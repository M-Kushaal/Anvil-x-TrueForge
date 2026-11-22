// Inline-edit history. Every inline edit is a turn in one shared TrueForge session per workspace
// (not a new session each time), and each edit is listed here. Both survive a window reload: they
// live in the workspace's storage, passed in as a Memento so this module stays testable.
import type { ForgeClient } from '../forge/client';

export type InlineStatus = 'running' | 'staged' | 'no-change' | 'failed' | 'stopped';

export interface InlineEntry {
  id: string;
  at: number;
  path: string;
  startLine: number;
  endLine: number;
  instruction: string;
  model: string;
  status: InlineStatus;
  detail?: string;
}

/** The part of VS Code's Memento (workspace storage) this module uses. */
export interface Store {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

const ENTRIES = 'anvil.inlineHistory';
const SESSION = 'anvil.inlineSession';
const SESSION_TURNS = 'anvil.inlineSessionTurns';
/** Edits per shared session before a new one starts, so old turns never crowd a small model. */
const MAX_TURNS = 6;
const LIMIT = 200;

export class InlineHistory {
  private readonly listeners = new Set<() => void>();
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private changed(): void { for (const listener of this.listeners) listener(); }
  constructor(private readonly store: Store) {}

  entries(): InlineEntry[] {
    return this.store.get<InlineEntry[]>(ENTRIES) ?? [];
  }

  /** The shared TrueForge session, if one exists yet. */
  session(): string | undefined {
    return this.store.get<string>(SESSION);
  }

  async setSession(id: string): Promise<void> {
    await this.store.update(SESSION, id);
    await this.store.update(SESSION_TURNS, 0);
  }

  /** Forget the shared session; the next edit starts a new one. */
  async resetSession(): Promise<void> {
    await this.store.update(SESSION, undefined);
  }

  /** Counts an edit in the shared session; returns true once it has had its share. */
  async countTurn(): Promise<boolean> {
    const turns = (this.store.get<number>(SESSION_TURNS) ?? 0) + 1;
    await this.store.update(SESSION_TURNS, turns);
    return turns > MAX_TURNS;
  }

  async add(entry: InlineEntry): Promise<void> {
    await this.store.update(ENTRIES, [entry, ...this.entries()].slice(0, LIMIT));
    this.changed();
  }

  async remove(id: string): Promise<void> {
    await this.store.update(ENTRIES, this.entries().filter((entry) => entry.id !== id));
    this.changed();
  }

  async finish(id: string, status: InlineStatus, detail?: string): Promise<void> {
    await this.store.update(ENTRIES, this.entries().map((e) => (e.id === id ? { ...e, status, ...(detail ? { detail } : {}) } : e)));
    this.changed();
  }
}

/**
 * The shared session for inline edits: reused when it still exists in TrueForge (its agent spec is
 * replaced for this edit), created otherwise: at first, every MAX_TURNS edits, and when the old one
 * was deleted in TrueForge.
 */
export async function inlineSession(client: ForgeClient, history: InlineHistory, spec: object): Promise<string> {
  const existing = history.session();
  if (existing && !(await history.countTurn())) {
    try {
      await client.setSpec(existing, spec);
      return existing;
    } catch {
      // Deleted or unreachable under that id: start a fresh shared session below.
    }
  }
  const id = await client.createSession(spec);
  await history.setSession(id);
  return id;
}

export const newEntryId = (): string => `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
