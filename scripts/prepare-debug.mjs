import { execFileSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const source = path.resolve(root, '../flask');
const commit = '22d924701a6ae2e4cd01e9a15bbaf3946094af65';
const debug = path.join(root, '.cache', 'debug');
mkdirSync(debug, { recursive: true });
const target = mkdtempSync(path.join(debug, 'flask-'));

// Copy Git metadata into a newly allocated directory, then check out committed files.
// Working-tree edits in the source are never copied.
cpSync(path.join(source, '.git'), path.join(target, '.git'), { recursive: true });
const git = (args) => execFileSync('git', args, {
  cwd: target, stdio: 'inherit', windowsHide: true,
});
git(['config', 'core.autocrlf', 'input']);
git(['config', 'core.filemode', 'false']);
git(['checkout', '--force', '--detach', commit]);
// Give each fresh demo workspace a Cerebras default, including when user settings prefer another provider.
const settingsDir = path.join(target, '.vscode');
mkdirSync(settingsDir, { recursive: true });
writeFileSync(path.join(settingsDir, 'settings.json'), JSON.stringify({
  'anvil.models': ['cerebras/gpt-oss-120b', 'groq/gpt-oss-120b', 'ollama/qwen2-5-3b'],
}, null, 2) + '\n');
const exclude = path.join(target, '.git', 'info', 'exclude');
appendFileSync(exclude, '\n/.vscode/settings.json\n');
writeFileSync(path.join(debug, 'flask.code-workspace'), JSON.stringify({
  folders: [{ path: target, name: `Fresh Flask - ${path.basename(target)}` }],
  settings: { 'window.restoreWindows': 'none', 'workbench.startupEditor': 'none' },
}, null, 2) + '\n');
console.log(`Fresh Flask workspace ready at ${target}`);
