import { describe, expect, it } from 'vitest';
import { DraftStore } from '../../../src/drafts/store';
import { locate } from '../../../src/drafts/locate';

const FILE = ['def get_debug_flag():', '    val = os.environ.get("FLASK_DEBUG")', '    return bool(val and val.lower() not in {"0", "false", "no"})', '', 'def other():', '    return 1', ''].join('\n');
const model = 'groq/gpt-oss-120b';

function staged() {
  const store = new DraftStore();
  const a = store.stage({ path: 'h.py', search: '"no"}', replace: '"no", "off", "n"}', model }, FILE);
  const b = store.stage({ path: 'h.py', search: '    return 1', replace: '    return 2', model }, FILE);
  return { store, a, b };
}

describe('locate', () => {
  it('finds a unique exact match', () => {
    expect(locate('a\nb\nc', 'b')).toEqual({ ok: true, start: 2, end: 3 });
  });
  it('rejects ambiguous matches with line numbers', () => {
    const r = locate('x\ny\nx', 'x');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/matches 2 places \(lines 1, 3\)/);
  });
  it('tolerates trailing-whitespace differences', () => {
    expect(locate('a  \nb\n', 'a\nb').ok).toBe(true);
  });
  it('points at the closest line when nothing matches', () => {
    const r = locate(FILE, '    val = os.environ.get("FLASK_DEBUGX")');
    expect(!r.ok && r.error).toMatch(/Closest line is L2/);
  });
});

describe('DraftStore', () => {
  it('stages edits without touching the real text, and the agent sees them', () => {
    const { store, a, b } = staged();
    expect(a).toMatchObject({ ok: true, added: 1, removed: 1, firstLine: 3 });
    expect(b).toMatchObject({ ok: true, pending: 2 });
    expect(store.view('h.py')).toContain('"off", "n"');
    expect(store.view('h.py')).toContain('return 2');
    expect(store.summary()).toEqual([{ path: 'h.py', added: 2, removed: 2, hunks: 2, isNew: false }]);
  });

  it('check() validates without staging', () => {
    const store = new DraftStore();
    expect(store.check({ path: 'h.py', search: 'return 1', replace: 'return 3', model }, FILE).ok).toBe(true);
    expect(store.all()).toHaveLength(0);
    expect(store.check({ path: 'h.py', search: 'nope', replace: 'x', model }, FILE).ok).toBe(false);
    expect(store.check({ path: 'missing.py', search: 'x', replace: 'y', model }, undefined)).toMatchObject({ ok: false });
  });

  it('keeps one hunk: real text gets exactly that change, the other stays pending', () => {
    const { store } = staged();
    const [first] = store.pending('h.py');
    const plan = store.planKeep('h.py', [first!.id], FILE);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.text).toContain('"off", "n"');
    expect(plan.text).toContain('return 1');
    plan.commit();
    expect(store.pending('h.py')).toHaveLength(1);
    expect(store.pending('h.py')[0]!.newLines).toEqual(['    return 2']);
  });

  it('undo drops a hunk from the proposal; resolving everything clears the draft', () => {
    const { store } = staged();
    const [first, second] = store.pending('h.py');
    store.undo('h.py', [second!.id]);
    expect(store.view('h.py')).toContain('return 1');
    const plan = store.planKeep('h.py', [first!.id], FILE);
    if (plan.ok) plan.commit();
    expect(store.get('h.py')).toBeUndefined();
  });

  it('applies a kept hunk even after the user edited elsewhere in the file', () => {
    const { store } = staged();
    const userEdited = `# a comment the user added\n${FILE}`;
    const plan = store.planKeep('h.py', 'all', userEdited);
    expect(plan.ok && plan.text.startsWith('# a comment the user added\n')).toBe(true);
    expect(plan.ok && plan.text).toContain('return 2');
  });

  it('refuses to keep when the original lines were changed by the user', () => {
    const { store } = staged();
    const plan = store.planKeep('h.py', 'all', FILE.replace('return 1', 'return 99'));
    expect(plan).toMatchObject({ ok: false });
  });

  it('creates new files as a single pending hunk and refuses existing paths', () => {
    const store = new DraftStore();
    expect(store.createFile({ path: 'new.py', content: 'x = 1\n', exists: false, model })).toMatchObject({ ok: true });
    expect(store.createFile({ path: 'h.py', content: 'x', exists: true, model })).toMatchObject({ ok: false });
    const plan = store.planKeep('new.py', 'all', '');
    expect(plan.ok && plan.text).toBe('x = 1\n');
  });

  it('reopen() brings back a kept change after an undo-apply', () => {
    const { store } = staged();
    const plan = store.planKeep('h.py', 'all', FILE);
    if (!plan.ok) throw new Error('plan failed');
    plan.commit();
    expect(store.get('h.py')).toBeUndefined();
    store.reopen({ path: 'h.py', before: FILE, after: plan.text, model });
    expect(store.pending('h.py')).toHaveLength(2);
  });

  it('notifies listeners on every change', () => {
    const store = new DraftStore();
    let calls = 0;
    store.onChange(() => calls++);
    store.stage({ path: 'h.py', search: 'return 1', replace: 'return 2', model }, FILE);
    store.undo('h.py', 'all');
    expect(calls).toBe(2);
  });

  it('locks proposal mutations until Keep finishes, including restore and reject all', () => {
    const { store } = staged();
    const snapshot = store.all();
    const revision = store.revision;
    const release = store.lock('h.py');
    expect(() => store.lock('h.py')).toThrow(/being applied/);
    expect(store.stage({ path: 'h.py', search: 'return 2', replace: 'return 3', model }, FILE)).toMatchObject({ ok: false });
    expect(store.check({ path: 'h.py', search: 'return 2', replace: 'return 3', model }, FILE)).toMatchObject({ ok: false });
    expect(store.createFile({ path: 'h.py', content: 'x', exists: false, model })).toMatchObject({ ok: false });
    expect(store.undo('h.py', 'all')).toBe(false);
    expect(store.discardAll()).toBe(false);
    expect(() => store.restore([])).toThrow(/being applied/);
    expect(() => store.reopen({ path: 'h.py', before: '', after: 'x', model })).toThrow(/being applied/);
    expect(store.all()).toEqual(snapshot);
    expect(store.revision).toBe(revision);
    release();
    release();
    expect(store.undo('h.py', 'all')).toBe(true);
    expect(store.revision).toBeGreaterThan(revision);
  });

  it('commits the planned hunks even if the proposal later changes', () => {
    const { store } = staged();
    const plan = store.planKeep('h.py', 'all', FILE);
    if (!plan.ok) throw new Error(plan.error);
    store.stage({ path: 'h.py', search: 'return 2', replace: 'return 3', model }, FILE);
    plan.commit();
    expect(store.get('h.py')?.base).toBe(plan.text);
    expect(store.pending('h.py')).toHaveLength(1);
    expect(store.pending('h.py')[0]?.oldLines).toEqual(['    return 2']);
    expect(store.pending('h.py')[0]?.newLines).toEqual(['    return 3']);
    const revision = store.revision;
    plan.commit();
    expect(store.revision).toBe(revision);
  });

  it('restores independent snapshots and advances its revision', () => {
    const { store } = staged();
    const snapshot = store.all();
    snapshot[0]!.proposed = 'external mutation';
    expect(store.view('h.py')).not.toBe('external mutation');
    const saved = store.all();
    const restored = new DraftStore();
    restored.restore(saved);
    expect(restored.all()).toEqual(store.all());
    expect(restored.revision).toBe(1);
    saved[0]!.proposed = 'another external mutation';
    expect(restored.view('h.py')).toBe(store.view('h.py'));
    expect(() => restored.restore([saved[0]!, saved[0]!])).toThrow(/invalid/);
    expect(restored.all()).toEqual(store.all());
  });

  it('rejects a stale keep plan after a change set was replaced', () => {
    const { store } = staged();
    const plan = store.planKeep('h.py', 'all', FILE);
    if (!plan.ok) throw new Error(plan.error);
    store.restore(store.all());
    expect(() => plan.commit()).toThrow(/changed while Keep/);
  });
});
