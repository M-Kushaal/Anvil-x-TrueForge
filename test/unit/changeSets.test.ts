import { describe, expect, it, vi } from 'vitest';
import { ChangeSets } from '../../src/drafts/changeSets';
import { DraftStore } from '../../src/drafts/store';
import type { Store } from '../../src/inline/history';

function memory(): Store {
  const data = new Map<string, unknown>();
  return {
    get: <T>(key: string) => data.has(key) ? JSON.parse(JSON.stringify(data.get(key))) as T : undefined,
    update: async (key, value) => { data.set(key, JSON.parse(JSON.stringify(value))); },
  };
}

function setup(storage = memory()) {
  const drafts = new DraftStore();
  const errors = vi.fn();
  const sets = new ChangeSets(storage, drafts, errors);
  const create = (path: string, content: string) => drafts.createFile({ path, content, model: 'model', exists: false });
  return { storage, drafts, sets, errors, create };
}

describe('ChangeSets', () => {
  it('persists pending proposals and restores the active task after reload', async () => {
    const { storage, sets, create } = setup();
    sets.activate('task-a', 'Implement feature');
    create('feature.ts', 'export const enabled = true;');
    await sets.flush();
    const restored = setup(storage);
    expect(restored.sets.activeId).toBe('task-a');
    expect(restored.sets.title).toBe('Implement feature');
    expect(restored.drafts.view('feature.ts')).toBe('export const enabled = true;');
    expect(restored.errors).not.toHaveBeenCalled();
  });

  it('isolates overlapping paths across tasks and retains inactive pending work', async () => {
    const { sets, drafts, create, storage } = setup();
    sets.activate('task-a', 'First task');
    create('shared.ts', 'first');
    sets.activate('task-b', 'Second task');
    expect(drafts.all()).toEqual([]);
    create('shared.ts', 'second');
    sets.activate('task-a', 'First task');
    expect(drafts.view('shared.ts')).toBe('first');
    expect(sets.list()).toEqual(expect.arrayContaining([
      { id: 'task-a', title: 'First task', files: 1 },
      { id: 'task-b', title: 'Second task', files: 1 },
    ]));
    await sets.flush();
    const recovered = setup(storage);
    recovered.sets.activate('task-b', 'Second task');
    expect(recovered.drafts.view('shared.ts')).toBe('second');
  });

  it('restores a persisted proposal checkpoint without mixing task checkpoints', async () => {
    const { sets, drafts, create, storage } = setup();
    sets.activate('task-a', 'First task');
    create('file.ts', 'before');
    sets.checkpoint();
    drafts.stage({ path: 'file.ts', search: 'before', replace: 'after', model: 'model' }, undefined);
    sets.activate('task-b', 'Second task');
    expect(sets.hasCheckpoint).toBe(false);
    expect(sets.restoreCheckpoint()).toBe(false);
    sets.activate('task-a', 'First task');
    expect(drafts.view('file.ts')).toBe('after');
    expect(sets.restoreCheckpoint()).toBe(true);
    expect(drafts.view('file.ts')).toBe('before');
    await sets.flush();
    const recovered = setup(storage);
    expect(recovered.sets.hasCheckpoint).toBe(true);
    expect(recovered.drafts.view('file.ts')).toBe('before');
  });

  it('rejects task switching during Keep without changing task ownership', () => {
    const { sets, drafts, create } = setup();
    sets.activate('task-a', 'First task');
    create('file.ts', 'first');
    const release = drafts.lock('file.ts');
    try {
      expect(() => sets.activate('task-b', 'Second task')).toThrow(/being applied|Keep/);
      expect(sets.activeId).toBe('task-a');
      expect(sets.title).toBe('First task');
      expect(drafts.view('file.ts')).toBe('first');
    } finally { release(); }
  });

  it('reports a failed persistence write and can save a subsequent change', async () => {
    const storage = memory();
    const original = storage.update;
    storage.update = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockImplementation(original);
    const { sets, errors, create } = setup(storage);
    sets.activate('task', 'Task');
    await sets.flush();
    expect(errors).toHaveBeenCalledWith(expect.objectContaining({ message: 'disk full' }));
    create('file.ts', 'retained');
    await sets.flush();
    expect(setup(storage).drafts.view('file.ts')).toBe('retained');
  });

  it('recovers valid tasks when another saved task is corrupt', async () => {
    const storage = memory();
    await storage.update('anvil.changeSets.v1', {
      version: 1, activeId: 'valid', sets: [
        null,
        { id: 'broken', title: 'Broken task', drafts: [{ path: 'x.ts', proposed: 123 }] },
        { id: 'valid', title: 'Valid task', updatedAt: 1, drafts: [
          { path: 'x.ts', base: '', proposed: 'recover me', model: 'model', isNew: true },
        ] },
      ],
    });
    const { drafts, sets, errors } = setup(storage);
    expect(sets.activeId).toBe('valid');
    expect(drafts.view('x.ts')).toBe('recover me');
    expect(errors).toHaveBeenCalledTimes(2);
  });

  it('preserves a checkpoint after every current proposal is rejected', async () => {
    const { sets, drafts, create, storage } = setup();
    sets.activate('task-a', 'First task');
    create('file.ts', 'before rejection');
    sets.checkpoint();
    drafts.discardAll();
    await sets.flush();
    const recovered = setup(storage);
    expect(recovered.drafts.all()).toEqual([]);
    expect(recovered.sets.hasCheckpoint).toBe(true);
    expect(recovered.sets.restoreCheckpoint()).toBe(true);
    expect(recovered.drafts.view('file.ts')).toBe('before rejection');
  });
});
