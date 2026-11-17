import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { outline } from '../../src/context/outline';
import { LexicalIndex, tokenize } from '../../src/context/lexical';
import { neighbours, parseGraphify } from '../../src/context/graph';
import { readIntent } from '../../src/context/pack';
import { ContextEngine } from '../../src/context/engine';
import { createWorkspace } from '../../src/workspace/workspace';

const TASK_B = 'Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.';

describe('outline', () => {
  it('finds python definitions with decorator-inclusive line ranges', () => {
    const text = ['import click', '', '', '@click.command("x")', 'def x_command():', '    pass', '', '', 'class A:', '    def m(self):', '        return 1', ''].join('\n');
    expect(outline('a.py', text).map((s) => [s.name, s.kind, s.line, s.endLine, s.parent])).toEqual([
      ['x_command', 'function', 4, 6, undefined],
      ['A', 'class', 9, 11, undefined],
      ['m', 'method', 10, 11, 'A'],
    ]);
  });

  it('splits RST and Markdown into sections', () => {
    expect(outline('d.rst', 'Title\n=====\n\ntext\n\nSub\n---\nmore').map((s) => [s.name, s.line, s.endLine])).toEqual([['Title', 1, 5], ['Sub', 6, 8]]);
    expect(outline('d.md', '# A\nx\n## B\ny').map((s) => s.name)).toEqual(['A', 'B']);
  });

  it('finds JS/TS functions, classes and arrow constants', () => {
    const names = outline('a.ts', 'export function f() {\n  return 1;\n}\nexport const g = async (x) => {\n  x;\n};\nclass C {\n}\n').map((s) => [s.name, s.endLine]);
    expect(names).toEqual([['f', 3], ['g', 6], ['C', 8]]);
  });
});

describe('lexical index', () => {
  it('splits identifiers and folds plurals', () => {
    expect(tokenize('getDebugFlag get_debug_flag commands')).toEqual(['get', 'debug', 'flag', 'get', 'debug', 'flag', 'command']);
  });

  it('ranks a path match above many body mentions', () => {
    const index = new LexicalIndex();
    index.set('src/cli.py', { symbols: ['routes_command'], body: 'click group' });
    index.set('src/config.py', { symbols: ['Config'], body: 'cli '.repeat(50) });
    index.set('src/other.py', { symbols: [], body: 'nothing here' });
    const cli = index.score('src/cli.py', ['cli']);
    const config = index.score('src/config.py', ['cli']);
    expect(2 * cli.path + cli.body).toBeGreaterThan(2 * config.path + config.body);
  });
});

describe('graph', () => {
  it('builds weighted file links and PageRank from graph.json', () => {
    const graph = parseGraphify({
      nodes: [
        { id: 'a', label: 'a.py', source_file: 'a.py' }, { id: 'a_f', label: 'f()', source_file: 'a.py' },
        { id: 'b_g', label: 'g()', source_file: 'b.py' }, { id: 't_x', label: 'test_x()', source_file: 'tests/test_a.py' },
      ],
      links: [
        { source: 'a_f', target: 'b_g', relation: 'calls' },
        { source: 't_x', target: 'a_f', relation: 'calls' },
        { source: 't_x', target: 'a_f', relation: 'calls' },
        { source: 'a_f', target: 'a', relation: 'contains' },
      ],
    });
    expect(neighbours(graph, 'a.py')).toEqual([{ file: 'tests/test_a.py', weight: 2 }, { file: 'b.py', weight: 1 }]);
    expect(graph.rank.get('a.py')).toBe(1);
  });
});

describe('readIntent', () => {
  it('infers roles and the kind of thing being added', () => {
    const intent = readIntent(TASK_B);
    expect(intent.roles).toEqual(['impl', 'test', 'docs']);
    expect(intent.noun).toBe('command');
    expect(intent.intentTerms).toEqual(['built', 'cli', 'command']);
  });

  it('asks only for implementation when tests and docs are not mentioned', () => {
    expect(readIntent('Rename the helper that loads env files').roles).toEqual(['impl']);
  });
});

describe('context pack on the fixture repo', () => {
  const engine = new ContextEngine(createWorkspace({ root: path.resolve(__dirname, '../fixtures/mini-repo') }));

  it('fills one file per role and drops the config distractors', async () => {
    const pack = await engine.pack(TASK_B, { budget: 3000 });
    const byKind = Object.fromEntries(pack.items.map((i) => [i.kind, i.path]));
    expect(byKind).toMatchObject({ impl: 'src/app/cli.py', test: 'tests/test_cli.py', docs: 'docs/cli.rst' });
    expect(pack.dropped.map((d) => d.path)).toEqual(expect.arrayContaining(['src/app/config.py', 'docs/config.rst']));
    expect(pack.items.find((i) => i.kind === 'impl')!.reasons.join(' ')).toMatch(/defines routes_command, shell_command/);
  });

  it('includes the pattern to follow, where it is registered, and the matching test and docs', async () => {
    const { text } = await engine.pack(TASK_B, { budget: 3000 });
    expect(text).toContain('Existing command to follow');
    expect(text).toMatch(/\d+│    cli\.add_command\(routes_command\)/);
    expect(text).toContain('TestRoutes (pattern to follow)');
    expect(text).toContain('Section "Routes"');
    expect(text).toContain('Likely files to change: src/app/cli.py, tests/test_cli.py, docs/cli.rst');
  });

  it('never exceeds the budget, shrinking snippets as needed', async () => {
    for (const budget of [3000, 1200, 600]) {
      const pack = await engine.pack(TASK_B, { budget });
      expect(pack.used).toBeLessThanOrEqual(budget);
    }
  });

  it('includes @-mentioned files first', async () => {
    const pack = await engine.pack('explain this', { budget: 3000, mentions: ['src/app/config.py'] });
    expect(pack.items[0]).toMatchObject({ kind: 'mention', path: 'src/app/config.py' });
  });

  it('shows an @-mentioned symbol from its own definition, not the top of the file', async () => {
    await engine.build();
    const mentions = engine.resolveMentions('why does @shell_command echo?');
    expect(mentions).toEqual([{ path: 'src/app/cli.py', line: 10, reason: 'you mentioned shell_command' }]);
    const pack = await engine.pack('why does @shell_command echo?', { budget: 3000, mentions });
    expect(pack.items[0]).toMatchObject({ kind: 'mention', path: 'src/app/cli.py', reasons: ['you mentioned shell_command'] });
    expect(pack.text).toMatch(/\n8│/); // the window starts just above the definition
    expect(pack.text).not.toMatch(/\n1│import click/);
  });

  it('finds symbols and suggests near misses', async () => {
    await engine.build();
    expect(engine.findSymbol('routes_command').hits[0]).toMatchObject({ path: 'src/app/cli.py', line: 4 });
    expect(engine.findSymbol('route_command').suggestions).toContain('routes_command');
  });

  it('excludes pinned files and graph neighbours without mutating later requests', async () => {
    const isolated = new ContextEngine(createWorkspace({ root: path.resolve(__dirname, '../fixtures/mini-repo') }));
    isolated.setGraph({ links: new Map([['src/app/cli.py', new Map([['src/app/config.py', 10]])]]), rank: new Map() });
    const pack = await isolated.pack(TASK_B, { budget: 3000, mentions: ['src/app/config.py'], exclude: ['./src\\app\\config.py', 'tests/'] });
    expect(pack.items.some((item) => item.path === 'src/app/config.py' || item.path.startsWith('tests/'))).toBe(false);
    const next = await isolated.pack(TASK_B, { budget: 3000, mentions: ['src/app/config.py'] });
    expect(next.items[0]).toMatchObject({ kind: 'mention', path: 'src/app/config.py' });
    expect(next.items.some((item) => item.path === 'tests/test_cli.py')).toBe(true);
  });
});

describe('context freshness', () => {
  const root = path.resolve(__dirname, '../fixtures/mini-repo');

  it('retrieves an unsaved or staged definition after coalesced invalidation', async () => {
    let live: string | undefined;
    const engine = new ContextEngine(createWorkspace({ root, liveText: (abs) => abs.endsWith('config.py') ? live : undefined }));
    await engine.build();
    live = 'def load_new_settings():\n    return "unsaved-version"\n';
    engine.invalidate('src/app/config.py');
    engine.invalidate('src/app/config.py');
    await engine.prepare();
    expect(engine.resolveMentions('explain @load_new_settings')).toEqual([{ path: 'src/app/config.py', line: 1, reason: 'you mentioned load_new_settings' }]);
    const pack = await engine.pack('explain @load_new_settings', { budget: 1000, mentions: ['src/app/config.py'] });
    expect(pack.text).toContain('unsaved-version');
    expect(engine.findSymbol('Config').hits).toEqual([]);
  });

  it('does not add ignored paths through filesystem refreshes', async () => {
    let reads = 0;
    const ws = createWorkspace({ root });
    const engine = new ContextEngine({ ...ws, read: async (p) => { reads++; return ws.read(p); } });
    await engine.build();
    const before = reads;
    await engine.refresh('node_modules/package/new.ts');
    engine.invalidate('.cache/generated.py');
    await engine.prepare();
    expect(reads).toBe(before);
  });

  it('does not let a slower previous read overwrite a newer definition', async () => {
    const ws = createWorkspace({ root });
    const pending: Array<(text: string) => void> = [];
    let delay = false;
    const engine = new ContextEngine({ ...ws, read: (p) => delay && p === 'src/app/config.py'
      ? new Promise<string>((resolve) => pending.push(resolve)) : ws.read(p) });
    await engine.build();
    delay = true;
    const old = engine.refresh('src/app/config.py');
    const latest = engine.refresh('src/app/config.py');
    pending[1]!('def newest():\n    pass\n');
    await latest;
    pending[0]!('def obsolete():\n    pass\n');
    await old;
    expect(engine.findSymbol('newest').hits).toHaveLength(1);
    expect(engine.findSymbol('obsolete').hits).toEqual([]);
  });

  it('makes a newly staged file available to symbol mentions before it exists on disk', async () => {
    const ws = createWorkspace({ root, liveText: (abs) => abs.endsWith('new-settings.ts')
      ? 'export function loadNewSettings() { return "staged-new-file"; }' : undefined });
    const engine = new ContextEngine(ws);
    await engine.build();
    engine.invalidate('src/new-settings.ts');
    await engine.prepare();
    const mentions = engine.resolveMentions('explain @loadNewSettings');
    expect(mentions).toEqual([{ path: 'src/new-settings.ts', line: 1, reason: 'you mentioned loadNewSettings' }]);
    expect((await engine.pack('explain new settings', { budget: 1000, mentions })).text).toContain('staged-new-file');
  });
});

// Regression coverage on a separate JS/TS project. These fixtures do not establish benchmark recall.
describe('retrieval on a separate JS/TS fixture', () => {
  const engine = new ContextEngine(createWorkspace({ root: path.resolve(__dirname, '../fixtures/heldout') }));
  it.each([
    { task: 'Make Cache remove expired values after expiration, with tests and documentation', impl: 'src/cache.ts', test: 'tests/cache.test.ts', docs: 'docs/cache.md' },
    { task: 'Make serializeMessage preserve optional message metadata, with tests and documentation', impl: 'src/serializer.js', test: 'tests/serializer.test.js', docs: 'docs/serializer.md' },
  ])('retrieves implementation, tests and docs for $impl', async ({ task, impl, test, docs }) => {
    const pack = await engine.pack(task, { budget: 3000 });
    const roles = Object.fromEntries(pack.items.map((item) => [item.kind, item.path]));
    expect(roles).toMatchObject({ impl, test, docs });
    expect(pack.used).toBeLessThanOrEqual(3000);
  });
});
