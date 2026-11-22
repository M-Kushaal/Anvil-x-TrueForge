// The draft layer: pending edits per file, never written until the user keeps them. Pure.
//
// Per file we hold `base` (what the real file is known to contain) and `proposed` (base plus every
// staged edit). Pending hunks are diff(base, proposed). Keep writes a hunk into the real file and
// folds it into `base`; Undo removes it from `proposed`. The agent reads `proposed`, so later
// edits build on earlier ones.
import { applyHunks, diffHunks, splitLines, stats, type Hunk } from './hunks';
import { locate } from './locate';
import type { FileChange } from '../shared/protocol';

export interface Draft {
  path: string;
  base: string;
  proposed: string;
  /** True when the file does not exist on disk yet. */
  isNew: boolean;
  model: string;
}

export interface EditRequest {
  path: string;
  search: string;
  replace: string;
  model: string;
}

export type StageResult =
  | { ok: true; added: number; removed: number; pending: number; firstLine: number }
  | { ok: false; error: string };

/** Outcome of planning a keep: the new real-file text, to be written by the caller. */
export type KeepPlan = { ok: true; text: string; baseBefore: string; baseAfter: string; commit: () => void } | { ok: false; error: string };

export class DraftStore {
  private drafts = new Map<string, Draft>();
  private listeners = new Set<() => void>();
  private locks = new Set<string>();
  private version = 0;

  get revision(): number { return this.version; }

  isLocked(path?: string): boolean {
    return path === undefined ? this.locks.size > 0 : this.locks.has(path);
  }

  /** Prevent proposal mutations while a caller applies a file asynchronously. */
  lock(path: string): () => void {
    if (this.locks.has(path)) throw new Error(`${path} is being applied. Wait for Keep to finish.`);
    this.locks.add(path);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.locks.delete(path);
    };
  }

  /** Restore a persisted change set without exposing the store's mutable objects. */
  restore(drafts: Draft[]): void {
    if (this.isLocked()) throw new Error('Changes are being applied. Wait for Keep to finish before switching change sets.');
    const restored = new Map<string, Draft>();
    for (const draft of drafts) {
      if (!draft || typeof draft.path !== 'string' || !draft.path || typeof draft.base !== 'string'
        || typeof draft.proposed !== 'string' || typeof draft.model !== 'string' || typeof draft.isNew !== 'boolean'
        || restored.has(draft.path)) throw new Error('The saved change set is invalid.');
      restored.set(draft.path, { ...draft });
    }
    this.drafts = restored;
    this.emit();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get(path: string): Draft | undefined {
    return this.drafts.get(path);
  }

  all(): Draft[] {
    return [...this.drafts.values()].map((draft) => ({ ...draft }));
  }

  pending(path: string): Hunk[] {
    const draft = this.drafts.get(path);
    if (!draft) return [];
    if (draft.isNew && draft.base === '' && draft.proposed === '') {
      return [{ id: 'create-empty', oldStart: 0, newStart: 0, oldLines: [], newLines: [] }];
    }
    return diffHunks(draft.base, draft.proposed);
  }

  /** What the agent should see for `path`, if a draft exists. */
  view(path: string): string | undefined {
    return this.drafts.get(path)?.proposed;
  }

  /** Files with pending hunks, for the chat, the Changes view and the status bar. */
  summary(): FileChange[] {
    return this.all()
      .map((d) => ({ path: d.path, isNew: d.isNew, hunks: this.pending(d.path).length, ...stats(this.pending(d.path)) }))
      .filter((s) => s.hunks > 0);
  }

  /** Validates without changing anything (used at the approval gate). */
  check(request: EditRequest, real: string | undefined): StageResult {
    return this.apply(request, real, false);
  }

  stage(request: EditRequest, real: string | undefined): StageResult {
    return this.apply(request, real, true);
  }

  createFile({ path, content, exists, model }: { path: string; content: string; exists: boolean; model: string }): StageResult {
    if (this.isLocked(path)) return { ok: false, error: `Error: ${path} is being applied. Wait for Keep to finish.` };
    if (exists || this.drafts.has(path)) return { ok: false, error: `Error: ${path} already exists. Use propose_edit to change it.` };
    const proposed = content.replace(/\r\n/g, '\n');
    this.drafts.set(path, { path, base: '', proposed, isNew: true, model });
    this.emit();
    return { ok: true, added: proposed === '' ? 0 : splitLines(proposed).length, removed: 0, pending: 1, firstLine: 1 };
  }

  /** Plans writing the given hunks into `real`. Call `commit()` after the write succeeds. */
  planKeep(path: string, hunkIds: string[] | 'all', real: string): KeepPlan {
    const draft = this.drafts.get(path);
    if (!draft) return { ok: false, error: `Nothing pending for ${path}.` };
    const chosen = this.pending(path).filter((h) => hunkIds === 'all' || hunkIds.includes(h.id));
    if (chosen.length === 0) return { ok: false, error: 'That change is no longer pending.' };

    const intervening = diffHunks(draft.base, real);
    const baseLines = splitLines(draft.base);
    const conflict: KeepPlan = { ok: false, error: `${path} changed near the proposed edit. Ask Anvil to redo it.` };
    const realLines = intervening.length ? splitLines(real) : baseLines;
    const mapped: Hunk[] = [];
    for (const hunk of chosen) {
      const start = Math.max(0, hunk.oldStart - 1);
      const end = Math.min(baseLines.length, hunk.oldStart + hunk.oldLines.length + 1);
      const anchors = baseLines.slice(start, end);
      // A line diff can align the wrong copy of a repeated block after one copy is removed.
      if (intervening.length && baseLines.some((line, i) => i !== start && line === anchors[0]
        && anchors.every((anchor, j) => baseLines[i + j] === anchor))) {
        return conflict;
      }
      let offset = 0;
      for (const change of intervening) {
        const changeEnd = change.oldStart + change.oldLines.length;
        const sameInsertion = hunk.oldLines.length === 0 && change.oldStart === hunk.oldStart;
        if (sameInsertion || (changeEnd > start && change.oldStart < end)) return conflict;
        if (changeEnd <= start) offset += change.newLines.length - change.oldLines.length;
      }
      const mappedStart = start + offset;
      if (intervening.length && (!anchors.every((anchor, j) => realLines[mappedStart + j] === anchor)
        || realLines.some((line, i) => i !== mappedStart && line === anchors[0]
          && anchors.every((anchor, j) => realLines[i + j] === anchor)))) return conflict;
      mapped.push({ ...hunk, oldStart: hunk.oldStart + offset });
    }
    const text = applyHunks(real, mapped);
    const base = draft.base;
    const kept = chosen.map((h) => ({ ...h, oldLines: [...h.oldLines], newLines: [...h.newLines] }));
    const baseAfter = applyHunks(base, kept);
    let committed = false;
    return {
      ok: true,
      text,
      baseBefore: base,
      baseAfter,
      commit: () => {
        if (committed) return;
        if (this.drafts.get(path) !== draft || draft.base !== base) throw new Error(`${path} changed while Keep was in progress.`);
        committed = true;
        draft.base = baseAfter;
        draft.isNew = false;
        this.settle(path);
      },
    };
  }

  /** Drops hunks from the proposal (nothing is written). */
  undo(path: string, hunkIds: string[] | 'all'): boolean {
    if (this.isLocked(path)) return false;
    const draft = this.drafts.get(path);
    if (!draft) return true;
    const pending = this.pending(path);
    const remaining = pending.filter((h) => hunkIds !== 'all' && !hunkIds.includes(h.id));
    if (draft.isNew && remaining.length === 0) this.drafts.delete(path);
    else draft.proposed = applyHunks(draft.base, remaining);
    this.settle(path);
    return true;
  }

  discardAll(): boolean {
    if (this.isLocked()) return false;
    this.drafts.clear();
    this.emit();
    return true;
  }

  /** Re-opens a kept change after "Undo last apply" restored the file to `before`. */
  reopen({ path, before, after, model, isNew = false }: { path: string; before: string; after: string; model: string; isNew?: boolean }): void {
    if (this.isLocked(path)) throw new Error(`${path} is being applied. Wait for Keep to finish.`);
    const draft = this.drafts.get(path);
    if (draft) {
      draft.base = before;
      draft.isNew = isNew;
    }
    else this.drafts.set(path, { path, base: before, proposed: after, isNew, model });
    this.settle(path);
  }

  private apply(request: EditRequest, real: string | undefined, commit: boolean): StageResult {
    if (this.isLocked(request.path)) return { ok: false, error: `Error: ${request.path} is being applied. Wait for Keep to finish.` };
    const draft = this.drafts.get(request.path);
    const current = draft?.proposed ?? real;
    if (current === undefined) return { ok: false, error: `Error: file not found: ${request.path}. Use create_file for new files.` };
    const search = request.search.replace(/\r\n/g, '\n');
    const replace = request.replace.replace(/\r\n/g, '\n');
    const found = locate(current, search);
    if (!found.ok) return found;
    const proposed = current.slice(0, found.start) + replace + current.slice(found.end);
    if (proposed === current) return { ok: false, error: 'Error: `replace` is identical to `search`; nothing would change.' };

    const edit = diffHunks(current, proposed);
    const firstLine = (edit[0]?.newStart ?? 0) + 1;
    if (commit) {
      if (draft) draft.proposed = proposed;
      else this.drafts.set(request.path, { path: request.path, base: current, proposed, isNew: false, model: request.model });
      this.emit();
    }
    const pendingCount = commit ? this.pending(request.path).length : diffHunks(draft?.base ?? current, proposed).length;
    return { ok: true, ...stats(edit), pending: pendingCount, firstLine };
  }

  private settle(path: string): void {
    const draft = this.drafts.get(path);
    if (draft && !draft.isNew && draft.base === draft.proposed) this.drafts.delete(path);
    this.emit();
  }

  private emit(): void {
    this.version++;
    for (const listener of this.listeners) listener();
  }
}
