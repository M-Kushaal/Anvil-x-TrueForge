import { randomUUID } from 'node:crypto';
import type { Store } from '../inline/history';
import { DraftStore, type Draft } from './store';

interface ChangeSet {
  id: string;
  title: string;
  drafts: Draft[];
  checkpoint?: Draft[];
  updatedAt: number;
}
interface Saved { version: 1; activeId: string; sets: ChangeSet[] }
const KEY = 'anvil.changeSets.v1';

/** Local proposals survive reloads and are isolated by task, including older chats. */
export class ChangeSets {
  private data: Saved;
  private switching = false;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly storage: Store, private readonly drafts: DraftStore, private readonly onError: (error: unknown) => void) {
    const saved = storage.get<unknown>(KEY);
    this.data = readSaved(saved, onError);
    const active = this.data.sets.find((s) => s.id === this.data.activeId);
    if (active) drafts.restore(active.drafts);
    drafts.onChange(() => { if (!this.switching) this.save(); });
  }

  get activeId(): string { return this.data.activeId; }
  get title(): string { return this.current().title; }
  get hasCheckpoint(): boolean { return this.current().checkpoint !== undefined; }

  activate(id: string, title: string): void {
    if (this.drafts.isLocked()) throw new Error('Wait for Keep to finish before switching tasks.');
    this.capture();
    const set = this.data.sets.find((s) => s.id === id);
    this.switching = true;
    try { this.drafts.restore(set?.drafts ?? []); } finally { this.switching = false; }
    this.data.activeId = id;
    this.current().title = title;
    this.save();
  }

  rename(title: string): void { this.current().title = title; this.save(); }

  checkpoint(): void {
    this.current().checkpoint = this.drafts.all();
    this.save();
  }

  restoreCheckpoint(): boolean {
    const checkpoint = this.current().checkpoint;
    if (!checkpoint) return false;
    this.drafts.restore(checkpoint);
    return true;
  }

  list(): Array<{ id: string; title: string; files: number }> {
    this.capture();
    return this.data.sets.filter((s) => s.drafts.length || s.checkpoint !== undefined).map((s) => ({ id: s.id, title: s.title, files: s.drafts.length }));
  }

  async flush(): Promise<void> { await this.writes; }

  private current(): ChangeSet {
    let set = this.data.sets.find((s) => s.id === this.data.activeId);
    if (!set) { set = { id: this.data.activeId, title: 'Recovered changes', drafts: [], updatedAt: Date.now() }; this.data.sets.push(set); }
    return set;
  }

  private capture(): void {
    const set = this.current();
    set.drafts = this.drafts.all();
    set.updatedAt = Date.now();
  }

  private save(): void {
    this.capture();
    // Never evict pending work; prune only empty inactive tasks without a checkpoint.
    this.data.sets = this.data.sets.filter((s) => s.id === this.activeId || s.drafts.length || s.checkpoint);
    const snapshot: Saved = JSON.parse(JSON.stringify(this.data));
    this.writes = this.writes.then(() => this.storage.update(KEY, snapshot)).then(() => undefined).catch(this.onError);
  }
}

function readSaved(value: unknown, onError: (error: unknown) => void): Saved {
  const empty: Saved = { version: 1, activeId: randomUUID(), sets: [] };
  if (value === undefined) return empty;
  if (!value || typeof value !== 'object') { onError(new Error('Invalid saved change sets')); return empty; }
  const saved = value as Saved;
  if (saved.version !== 1 || typeof saved.activeId !== 'string' || !Array.isArray(saved.sets)) {
    onError(new Error('Unsupported saved change sets')); return empty;
  }
  const sets: ChangeSet[] = [];
  for (const set of saved.sets) {
    try {
      if (!set || typeof set.id !== 'string' || typeof set.title !== 'string' || !Array.isArray(set.drafts)) throw new Error('Invalid saved task');
      const validation = new DraftStore();
      validation.restore(set.drafts);
      if (set.checkpoint !== undefined) validation.restore(set.checkpoint);
      if (sets.some((s) => s.id === set.id)) throw new Error('Duplicate saved task');
      sets.push(JSON.parse(JSON.stringify(set)) as ChangeSet);
    } catch (error) { onError(error); }
  }
  return { version: 1, activeId: saved.activeId, sets };
}
