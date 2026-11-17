// Renders the built chat webview outside VS Code with a theme's CSS variables and a sample
// state, then screenshots it with headless Edge/Chrome. For design review only.
// Run: npm run build && node scripts/preview.mjs [dark|light] [scenario]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const theme = process.argv[2] ?? 'dark';
const scenario = process.argv[3] ?? 'agent';
const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'preview');
mkdirSync(out, { recursive: true });

const THEMES = {
  // Subset of VS Code "Dark Modern" / "Light Modern" colours used by tokens.css.
  dark: {
    'sideBar-background': '#181818', 'editor-background': '#1f1f1f', 'editorWidget-background': '#202020', 'input-background': '#313131',
    'widget-border': '#313131', 'panel-border': '#2b2b2b', foreground: '#cccccc', descriptionForeground: '#9d9d9d', 'textLink-foreground': '#4daafc',
    focusBorder: '#0078d4', 'button-background': '#0078d4', 'button-foreground': '#ffffff', 'button-hoverBackground': '#026ec1',
    'button-secondaryBackground': '#313131', 'button-secondaryForeground': '#cccccc', 'button-secondaryHoverBackground': '#3c3c3c',
    'list-hoverBackground': '#2a2d2e', 'gitDecoration-addedResourceForeground': '#81b88b', 'gitDecoration-deletedResourceForeground': '#c74e39',
    'editorWarning-foreground': '#cca700', errorForeground: '#f85149', 'charts-blue': '#3794ff', 'charts-green': '#89d185', 'charts-purple': '#b180d7', 'charts-yellow': '#cca700', 'badge-background': '#616161', 'badge-foreground': '#f8f8f8',
    'textCodeBlock-background': '#2b2b2b', 'input-foreground': '#cccccc', 'input-placeholderForeground': '#989898',
  },
  light: {
    'sideBar-background': '#f8f8f8', 'editor-background': '#ffffff', 'editorWidget-background': '#f8f8f8', 'input-background': '#ffffff',
    'widget-border': '#e5e5e5', 'panel-border': '#e5e5e5', foreground: '#3b3b3b', descriptionForeground: '#717171', 'textLink-foreground': '#005fb8',
    focusBorder: '#005fb8', 'button-background': '#005fb8', 'button-foreground': '#ffffff', 'button-hoverBackground': '#0258a8',
    'button-secondaryBackground': '#e5e5e5', 'button-secondaryForeground': '#3b3b3b', 'button-secondaryHoverBackground': '#cccccc',
    'list-hoverBackground': '#f2f2f2', 'gitDecoration-addedResourceForeground': '#587c0c', 'gitDecoration-deletedResourceForeground': '#ad0707',
    'editorWarning-foreground': '#bf8803', errorForeground: '#f85149', 'charts-blue': '#1a85ff', 'charts-green': '#388a34', 'charts-purple': '#652d90', 'charts-yellow': '#bf8803', 'badge-background': '#cccccc', 'badge-foreground': '#3b3b3b',
    'textCodeBlock-background': '#f2f2f2', 'input-foreground': '#3b3b3b', 'input-placeholderForeground': '#767676',
  },
};

const SCENARIOS = {
  context: null,
  empty: { title: 'New chat', items: [], running: false, model: 'groq/gpt-oss-120b', changes: [] },
  agent: {
    title: 'Add a flask config command',
    model: 'groq/gpt-oss-120b',
    running: true,
    startedAt: Date.now() - 14000,
    items: [
      { kind: 'user', id: 'u1', text: 'Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***".' },
      { kind: 'context', id: 'c1', context: { used: 2610, budget: 3000, source: 'Ranked by keywords and the code graph · 212 files',
        items: [
          { kind: 'impl', path: 'src/flask/cli.py', tokens: 1240, reasons: ['defines run_command, shell_command, routes_command (same kind as the new command)'] },
          { kind: 'test', path: 'tests/test_cli.py', tokens: 610, reasons: ['test file for cli.py', 'calls or imports cli.py'] },
          { kind: 'docs', path: 'docs/cli.rst', tokens: 520, reasons: ['docs page for cli.py', 'documents shell, run'] },
          { kind: 'related', path: 'src/flask/app.py', tokens: 40, reasons: ['linked to cli.py in the code'] },
        ],
        dropped: [{ path: 'src/flask/config.py', reason: 'matches only "config", not the built cli command pattern' }, { path: 'docs/config.rst', reason: 'weaker docs match than cli.rst' }] } },
      { kind: 'tool', id: 't1', threadId: 'main', name: 'search_code', args: '{"query":"add_command","glob":"*.py"}', status: 'done', summary: '"add_command" · 6 hits in 2 files' },
      { kind: 'thread', id: 'th', title: 'Explorer', status: 'done' },
      { kind: 'tool', id: 't2', threadId: 'th', name: 'read_file', args: '{"path":"src/flask/cli.py","start":1040}', status: 'done', summary: 'src/flask/cli.py · lines 1040–1139 of 1127' },
      { kind: 'tool', id: 't3', threadId: 'th', name: 'search_code', args: '{"query":"routes","glob":"docs/**"}', status: 'done', summary: '"routes" · 9 hits in 3 files' },
      { kind: 'text', id: 'm1', threadId: 'main', text: 'The built-in commands live in `src/flask/cli.py` and are registered in `FlaskGroup.__init__`. I will add `config_command` next to `routes_command`, a test in `tests/test_cli.py`, and a section in `docs/cli.rst`.' },
      { kind: 'tool', id: 't4', threadId: 'main', name: 'propose_edit', args: '{"path":"src/flask/cli.py"}', status: 'done', summary: 'src/flask/cli.py · pending +31 −0' },
      { kind: 'tool', id: 't5', threadId: 'main', name: 'propose_edit', args: '{"path":"tests/test_cli.py"}', status: 'running' },
    ],
    changes: [
      { path: 'src/flask/cli.py', added: 31, removed: 0, hunks: 2, isNew: false },
      { path: 'docs/cli.rst', added: 12, removed: 0, hunks: 1, isNew: false },
    ],
  },
  stopped: {
    title: 'Treat off and n as false',
    model: 'groq/gpt-oss-120b',
    running: false,
    lastTurn: { tokens: 2496, ms: 6400 },
    items: [
      { kind: 'user', id: 'u1', text: 'Write a long summary of every method in app.py' },
      { kind: 'tool', id: 't1', threadId: 'main', name: 'read_file', args: '{"path":"src/flask/app.py"}', status: 'done', summary: 'src/flask/app.py · lines 1–100 of 1536' },
      { kind: 'notice', id: 'n2', level: 'info', title: 'Answered by ollama/qwen2-5-3b', detail: 'groq/gpt-oss-120b: 401 invalid API key' },
      { kind: 'notice', id: 'n1', level: 'info', title: 'Stopped', detail: '2 changes waiting for review.' },
    ],
    changes: [],
  },
};

SCENARIOS.context = { ...SCENARIOS.agent, running: false, changes: [], items: SCENARIOS.agent.items.slice(0, 2) };
const vars = Object.entries(THEMES[theme]).map(([k, v]) => `--vscode-${k.replace(/\./g, '-')}: ${v};`).join('\n');
const html = `<!doctype html><html><head><meta charset="utf-8">
<style>:root{${vars} --vscode-font-family: "Segoe UI", system-ui, sans-serif; --vscode-editor-font-family: Consolas, "Cascadia Mono", monospace; --vscode-font-size: 13px;}</style>
<link rel="stylesheet" href="../dist/webview.css">
<script>window.acquireVsCodeApi = () => ({ postMessage() {} });</script>
<style>html,body{background:#111}#panel{background:var(--vscode-sideBar-background);width:400px;height:820px;border-right:1px solid #444;overflow:hidden}</style></head><body class="vscode-${theme}"><div id="panel"><div id="root"></div></div>
<script src="../dist/webview.js"></script>
<script>setTimeout(() => window.postMessage({ type: 'state', state: ${JSON.stringify(SCENARIOS[scenario])} }, '*'), 50);</script>
</body></html>`;
const file = path.join(out, `preview-${theme}-${scenario}.html`);
writeFileSync(file, html);

const browsers = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'];
const browser = browsers.find((b) => existsSync(b));
if (!browser) throw new Error('No Edge/Chrome found for screenshots');
const png = path.join(out, `preview-${theme}-${scenario}.png`);
execFileSync(browser, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--screenshot=${png}`, '--window-size=560,820', '--virtual-time-budget=2000', `file:///${file.replace(/\\/g, '/')}`], { stdio: 'ignore' });
console.log(png);
