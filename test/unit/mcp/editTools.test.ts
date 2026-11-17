import { describe, expect, it } from 'vitest';
import { DraftStore } from '../../../src/drafts/store';
import { editTools, validateEdit, type EditContext } from '../../../src/mcp/editTools';

const files: Record<string, string> = { 'a.py': 'def f():\n    return 1\n' };

function setup() {
  const drafts = new DraftStore();
  const ctx: EditContext = { drafts, realText: async (p) => files[p], model: () => 'groq/gpt-oss-120b' };
  const tool = (name: string) => editTools(ctx).find((t) => t.name === name)!;
  return { drafts, ctx, tool };
}

describe('edit tools', () => {
  it('propose_edit stages a change and says it is not written', async () => {
    const { drafts, tool } = setup();
    const out = await tool('propose_edit').run({ path: 'a.py', search: '    return 1', replace: '    return 2' });
    expect(out.split('\n')[0]).toBe('a.py · pending +1 −1');
    expect(out).toContain('Not written yet');
    expect(drafts.view('a.py')).toContain('return 2');
    expect(files['a.py']).toContain('return 1'); // real file untouched
  });

  it('treats ./a.py and a.py as one file, so a second edit builds on the first', async () => {
    const drafts = new DraftStore();
    const ctx: EditContext = {
      drafts, realText: async (p) => files[p], model: () => 'm',
      normalize: (p) => p.replace(/\\/g, '/').replace(/^\.\//, ''),
    };
    const propose = editTools(ctx).find((t) => t.name === 'propose_edit')!;
    await propose.run({ path: './a.py', search: 'def f():', replace: 'def g():' });
    await propose.run({ path: 'a.py', search: '    return 1', replace: '    return 2' });
    expect(drafts.all().map((d) => d.path)).toEqual(['a.py']);
    expect(drafts.view('a.py')).toBe('def g():\n    return 2\n');
  });

  it('later edits build on staged ones', async () => {
    const { drafts, tool } = setup();
    await tool('propose_edit').run({ path: 'a.py', search: '    return 1', replace: '    return 2' });
    const out = await tool('propose_edit').run({ path: 'a.py', search: '    return 2', replace: '    return 3' });
    expect(out).toMatch(/^a\.py · pending/);
    expect(drafts.pending('a.py')).toHaveLength(1);
    expect(drafts.view('a.py')).toContain('return 3');
  });

  it('create_file stages a new file and refuses existing ones', async () => {
    const { drafts, tool } = setup();
    expect(await tool('create_file').run({ path: 'b.py', content: 'x = 1\n' })).toMatch(/^b\.py · pending \+2 −0/);
    expect(drafts.get('b.py')?.isNew).toBe(true);
    expect(await tool('create_file').run({ path: 'a.py', content: 'x' })).toMatch(/^Error: a\.py already exists/);
  });

  it('validateEdit denies bad edits at the approval gate without staging', async () => {
    const { drafts, ctx } = setup();
    expect(await validateEdit(ctx, 'propose_edit', JSON.stringify({ path: 'a.py', search: 'return 9', replace: 'x' }))).toMatch(/not found/);
    expect(await validateEdit(ctx, 'propose_edit', JSON.stringify({ path: 'nope.py', search: 'x', replace: 'y' }))).toMatch(/file not found/);
    expect(await validateEdit(ctx, 'propose_edit', '{bad json')).toMatch(/not valid JSON/);
    expect(await validateEdit(ctx, 'propose_edit', JSON.stringify({ path: 'a.py', search: 'return 1', replace: 'return 2' }))).toBeUndefined();
    expect(drafts.all()).toHaveLength(0);
  });
});
