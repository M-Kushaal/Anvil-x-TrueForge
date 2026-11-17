// Retrieval evaluation on the pinned Flask checkout (3.1.3): for 8 realistic tasks with known
// target files, does the context engine pick the right file for each role? Prints recall@1 and
// recall@3 per role. Skipped when ../flask is absent. Run: npm run eval
import { existsSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ContextEngine } from '../../src/context/engine';
import { buildGraph } from '../../src/context/graphify';
import { createWorkspace } from '../../src/workspace/workspace';
import { flaskRoot, projectRoot } from '../support/paths';

const FLASK = flaskRoot;
const GRAPHIFY = process.env.GRAPHIFY_BIN ?? 'graphify';

const TASK_B = 'Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.';

export const TASKS: Array<{ request: string; impl: string; test?: string; docs?: string }> = [
  { request: TASK_B, impl: 'src/flask/cli.py', test: 'tests/test_cli.py', docs: 'docs/cli.rst' },
  { request: "Make get_debug_flag treat 'off' and 'n' as false and cover it with a test", impl: 'src/flask/helpers.py', test: 'tests/test_helpers.py' },
  { request: 'Add a new method to Config that loads values from a TOML file, with tests and documentation', impl: 'src/flask/config.py', test: 'tests/test_config.py', docs: 'docs/config.rst' },
  { request: 'Add a new signal sent after the session is saved, and document it with the other signals', impl: 'src/flask/signals.py', docs: 'docs/signals.rst' },
  { request: 'Let the test client follow redirects by default, with a test', impl: 'src/flask/testing.py', test: 'tests/test_testing.py' },
  { request: 'Add a new JSON tag that serializes Decimal values in the session, with a test', impl: 'src/flask/json/tag.py', test: 'tests/test_json_tag.py' },
  { request: 'Change the default log format used by the app logger and update the logging docs', impl: 'src/flask/logging.py', docs: 'docs/logging.rst' },
  { request: 'Add an option to MethodView to set the allowed methods explicitly, with a test', impl: 'src/flask/views.py', test: 'tests/test_views.py' },
];

const present = existsSync(path.join(FLASK, 'src/flask/cli.py'));
const engine = new ContextEngine(createWorkspace({ root: FLASK }));

describe.skipIf(!present)('retrieval on Flask 3.1.3', () => {
  beforeAll(async () => {
    const { graph, message } = await buildGraph({ root: FLASK, outDir: path.join(projectRoot, '.cache/flask-graph'), command: GRAPHIFY });
    if (graph) engine.setGraph(graph);
    console.log(message, `graph links: ${graph?.links.size ?? 0}`);
  }, 300_000);

  it('Task B: one file per role, config distractors dropped, within budget', async () => {
    const pack = await engine.pack(TASK_B, { budget: 3000 });
    console.log(pack.text);
    expect(Object.fromEntries(pack.items.filter((i) => ['impl', 'test', 'docs'].includes(i.kind)).map((i) => [i.kind, i.path])))
      .toEqual({ impl: 'src/flask/cli.py', test: 'tests/test_cli.py', docs: 'docs/cli.rst' });
    expect(pack.dropped.map((d) => d.path)).toContain('src/flask/config.py');
    expect(pack.used).toBeLessThanOrEqual(3000);
  });

  it('recall over 8 tasks', async () => {
    const hits = { impl: [0, 0, 0], test: [0, 0, 0], docs: [0, 0, 0] } as Record<'impl' | 'test' | 'docs', number[]>; // [at1, at3, total]
    const rows: string[] = [];
    for (const task of TASKS) {
      const ranked = await engine.rank(task.request);
      for (const role of ['impl', 'test', 'docs'] as const) {
        const want = task[role];
        if (!want) continue;
        const list = ranked[role];
        hits[role][2]!++;
        if (list[0] === want) hits[role][0]!++;
        if (list.slice(0, 3).includes(want)) hits[role][1]!++;
        rows.push(`${list[0] === want ? 'ok ' : 'MISS'} ${role.padEnd(4)} ${want.padEnd(26)} got ${list.slice(0, 3).join(', ')}`);
      }
    }
    const fmt = (role: 'impl' | 'test' | 'docs') => `${role}: recall@1 ${hits[role][0]}/${hits[role][2]}, recall@3 ${hits[role][1]}/${hits[role][2]}`;
    console.log([...rows, fmt('impl'), fmt('test'), fmt('docs')].join('\n'));
    const at3 = (['impl', 'test', 'docs'] as const).reduce((n, r) => n + hits[r][1]!, 0);
    const total = (['impl', 'test', 'docs'] as const).reduce((n, r) => n + hits[r][2]!, 0);
    expect(at3 / total).toBeGreaterThanOrEqual(0.8);
  });
});
