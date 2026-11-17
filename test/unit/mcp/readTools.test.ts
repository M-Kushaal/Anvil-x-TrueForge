import { describe, expect, it } from 'vitest';
import { createWorkspace } from '../../../src/workspace/workspace';
import { readTools, readWindow } from '../../../src/mcp/readTools';
import { globToRegExp } from '../../../src/workspace/glob';
import { fixturePath } from '../../support/paths';

const root = fixturePath('mini-repo');
const ws = createWorkspace({ root });
const tool = (name: string) => readTools(ws).find((t) => t.name === name)!;

describe('workspace', () => {
  it('lists text files relative to the root and skips binaries', async () => {
    expect(await ws.files()).toEqual(['docs/cli.rst', 'docs/config.rst', 'src/app/cli.py', 'src/app/config.py', 'tests/test_cli.py']);
  });

  it('refuses paths outside the workspace', () => {
    expect(() => ws.resolve('../../secrets.txt')).toThrow(/outside the workspace/);
  });

  it('prefers live editor text over disk', async () => {
    const live = createWorkspace({ root, liveText: (abs) => (abs.endsWith('config.py') ? 'unsaved' : undefined) });
    expect(await live.read('src/app/config.py')).toBe('unsaved');
  });
});

describe('read_file', () => {
  it('accepts line_start/line_end, which models often send instead of start/end', async () => {
    const out = await tool('read_file').run({ path: 'src/app/config.py', line_start: 2, line_end: 3 });
    expect(out).toMatch(/lines 2–3/);
  });

  it('returns numbered lines with a summary header', async () => {
    const out = await tool('read_file').run({ path: 'src/app/config.py' });
    expect(out.split('\n')[0]).toBe('src/app/config.py · lines 1–6 of 6');
    expect(out).toContain('1│class Config(dict):');
  });

  it('pages long files and says how to continue', () => {
    const text = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\n');
    const out = readWindow({ text, path: 'big.py' });
    expect(out.split('\n')[0]).toBe('big.py · lines 1–100 of 300');
    expect(out).toContain('Call read_file with start=101 to continue.');
  });

  it('caps a requested range at 250 lines', () => {
    const text = Array.from({ length: 1000 }, () => 'x').join('\n');
    expect(readWindow({ text, path: 'big.py', start: 1, end: 900 }).split('\n')[0]).toBe('big.py · lines 1–250 of 1000');
  });

  it('reports a missing file as an error line', async () => {
    expect(await tool('read_file').run({ path: 'nope.py' })).toMatch(/^Error: file not found/);
  });

  it('reports invalid arguments instead of throwing', async () => {
    expect(await tool('read_file').run({})).toMatch(/^Error: invalid arguments for read_file/);
  });
});

describe('list_dir', () => {
  it('lists directories first', async () => {
    const out = await tool('list_dir').run({ path: 'src/app' });
    expect(out.split('\n')).toEqual(['src/app · 2 entries', 'cli.py', 'config.py']);
  });
});

describe('search_code', () => {
  it('shows context for a few hits', async () => {
    const out = await tool('search_code').run({ query: 'from_mapping' });
    expect(out.split('\n')[0]).toBe('"from_mapping" · 1 hit in 1 file');
    expect(out).toContain('src/app/config.py:4');
  });

  it('groups many hits per file', async () => {
    const out = await tool('search_code').run({ query: 'command' });
    expect(out.split('\n')[0]).toMatch(/^"command" · \d+ hits in 2 files$/);
    expect(out).toContain('  L4  @click.command("routes")');
  });

  it('filters with a glob', async () => {
    const out = await tool('search_code').run({ query: 'routes', glob: '*.rst' });
    expect(out).toContain('docs/cli.rst');
    expect(out).not.toContain('cli.py');
  });

  it('limits a search to a file or folder', async () => {
    const out = await tool('search_code').run({ query: 'routes', path: 'docs/' });
    expect(out).toContain('docs/cli.rst');
    expect(out).not.toContain('src/app');
  });

  it('suggests alternatives when nothing matches', async () => {
    expect(await tool('search_code').run({ query: 'zzz_nothing' })).toContain('No matches');
  });
});

describe('globToRegExp', () => {
  it.each([
    ['*.py', 'src/app/cli.py', true],
    ['*.py', 'docs/cli.rst', false],
    ['docs/**', 'docs/api/x.rst', true],
    ['src/**/*.py', 'src/cli.py', true],
    ['src/*.py', 'src/app/cli.py', false],
  ])('%s matches %s → %s', (glob, file, expected) => {
    expect(globToRegExp(glob).test(file)).toBe(expected);
  });
});
