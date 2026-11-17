import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workspace } from '../../../src/workspace/workspace';

const state = vi.hoisted(() => ({ text: 'before', dirty: false, exists: true, save: vi.fn(), apply: vi.fn() }));

vi.mock('vscode', () => {
  class Range { constructor(public start: number, public end: number) {} }
  class WorkspaceEdit {
    replacement?: { range: Range; text: string };
    replace(_uri: unknown, range: Range, text: string) { this.replacement = { range, text }; }
  }
  const document = {
    uri: { fsPath: '/workspace/file.ts', scheme: 'file' },
    get isDirty() { return state.dirty; },
    eol: 1,
    getText: () => state.text,
    positionAt: (index: number) => index,
    save: () => state.save(),
  };
  return {
    Uri: { file: (fsPath: string) => ({ fsPath, scheme: 'file' }) },
    EndOfLine: { LF: 1, CRLF: 2 },
    Range, WorkspaceEdit,
    EventEmitter: class { event = vi.fn(); fire = vi.fn(); },
    TabInputTextDiff: class {},
    window: { tabGroups: { all: [], close: vi.fn() } },
    workspace: {
      textDocuments: [document],
      fs: { stat: async () => { if (!state.exists) throw new Error('missing'); return {}; } },
      openTextDocument: async () => document,
      applyEdit: (edit: WorkspaceEdit) => state.apply(edit),
    },
  };
});

import { writeReal } from '../../../src/review/files';
import { ReviewService } from '../../../src/review/review';
import { DraftStore } from '../../../src/drafts/store';

interface Edit { replacement?: { range: { start: number; end: number }; text: string } }
function apply(edit: Edit): boolean {
  if (edit.replacement) {
    const { range, text } = edit.replacement;
    state.text = state.text.slice(0, range.start) + text + state.text.slice(range.end);
    state.dirty = true;
  }
  return true;
}
const ws: Workspace = {
  root: '/workspace', resolve: (path) => `/workspace/${path}`,
  read: async () => state.text, list: async () => [], files: async () => ['file.ts'], invalidate: () => undefined,
};

beforeEach(() => {
  state.text = 'before'; state.dirty = false; state.exists = true;
  state.apply.mockReset().mockImplementation(async (edit: Edit) => apply(edit));
  state.save.mockReset().mockImplementation(async () => { state.dirty = false; return true; });
});

describe('review file application', () => {
  it.each(['false', 'throws'])('reports a successfully applied buffer separately when save %s', async (failure) => {
    if (failure === 'false') state.save.mockResolvedValue(false);
    else state.save.mockRejectedValue(new Error('read-only disk'));
    await expect(writeReal(ws, 'file.ts', 'after', { text: 'before' })).resolves.toEqual({ saved: false });
    expect(state.text).toBe('after');
    expect(state.dirty).toBe(true);
    expect(state.apply).toHaveBeenCalledOnce();
  });

  it('preserves existing unsaved work without attempting to save it', async () => {
    state.dirty = true;
    await expect(writeReal(ws, 'file.ts', 'after', { text: 'before' })).resolves.toEqual({ saved: false });
    expect(state.save).not.toHaveBeenCalled();
    expect(state.text).toBe('after');
  });

  it('rejects a stale expected snapshot before applying an edit', async () => {
    state.text = 'user changed it';
    await expect(writeReal(ws, 'file.ts', 'after', { text: 'before' })).rejects.toThrow(/changed while preparing/);
    expect(state.apply).not.toHaveBeenCalled();
    expect(state.text).toBe('user changed it');
  });

  it.each(['false', 'throws'])('settles kept insertions after save %s so retry cannot apply them twice', async (failure) => {
    const drafts = new DraftStore();
    drafts.stage({ path: 'file.ts', search: 'before', replace: 'inserted\nbefore', model: 'm' }, state.text);
    const notify = vi.fn();
    const review = new ReviewService(ws, drafts, notify);
    if (failure === 'false') state.save.mockResolvedValue(false);
    else state.save.mockRejectedValue(new Error('disk unavailable'));
    expect(await review.keep('file.ts', 'all')).toBe(true);
    expect(drafts.all()).toEqual([]);
    expect(state.text).toBe('inserted\nbefore');
    expect(await review.keep('file.ts', 'all')).toBe(false);
    expect(state.apply).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/unsaved changes/));
  });

  it('locks staging, rejecting and task switching until a kept change is reverted', async () => {
    const drafts = new DraftStore();
    drafts.stage({ path: 'file.ts', search: 'before', replace: 'after', model: 'm' }, state.text);
    const review = new ReviewService(ws, drafts, vi.fn());
    await review.keep('file.ts', 'all');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    state.apply.mockImplementationOnce(async (edit: Edit) => { await gate; return apply(edit); });
    const reverting = review.undoLastApply();
    await vi.waitFor(() => expect(state.apply).toHaveBeenCalledTimes(2));
    expect(drafts.isLocked('file.ts')).toBe(true);
    expect(drafts.stage({ path: 'file.ts', search: 'after', replace: 'other', model: 'm' }, state.text)).toMatchObject({ ok: false });
    expect(drafts.discardAll()).toBe(false);
    expect(() => review.setChangeSet('another-task')).toThrow(/switching tasks/);
    release();
    await reverting;
    expect(drafts.isLocked()).toBe(false);
    expect(state.text).toBe('before');
    expect(drafts.view('file.ts')).toBe('after');
  });

  it('keeps revert history isolated to the selected change set', async () => {
    const drafts = new DraftStore();
    const notify = vi.fn();
    const review = new ReviewService(ws, drafts, notify);
    review.setChangeSet('task-a');
    drafts.stage({ path: 'file.ts', search: 'before', replace: 'after', model: 'm' }, state.text);
    await review.keep('file.ts', 'all');
    review.setChangeSet('task-b');
    await review.undoLastApply();
    expect(state.text).toBe('after');
    expect(notify).toHaveBeenCalledWith('No kept change to revert.');
    review.setChangeSet('task-a');
    await review.undoLastApply();
    expect(state.text).toBe('before');
    expect(drafts.view('file.ts')).toBe('after');
  });

  it('preflights every file before Keep all writes any file', async () => {
    const drafts = new DraftStore();
    drafts.stage({ path: 'file.ts', search: 'before', replace: 'after', model: 'm' }, state.text);
    drafts.stage({ path: 'missing.ts', search: 'original', replace: 'proposal', model: 'm' }, 'original');
    const notify = vi.fn();
    const review = new ReviewService(ws, drafts, notify);
    await review.keepAll();
    expect(state.apply).not.toHaveBeenCalled();
    expect(state.text).toBe('before');
    expect(drafts.summary()).toHaveLength(2);
    expect(drafts.isLocked()).toBe(false);
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/before writing any files/));
  });
});
