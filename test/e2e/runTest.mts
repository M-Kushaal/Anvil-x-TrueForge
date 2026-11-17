// Launches a real VS Code with Anvil on a throwaway copy of the fixture repo and runs the e2e suite.
// Run: npm run test:e2e
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runTests } from '@vscode/test-electron';

// Running from inside VS Code (its terminal or an extension) leaks variables that make Electron act as
// Node or attach to the running VS Code, so the suite silently never runs. Start from a clean slate.
for (const key of Object.keys(process.env)) if (/^(VSCODE_|ELECTRON_)/.test(key)) delete process.env[key];

const root = path.resolve(import.meta.dirname, '../..');
const workspace = mkdtempSync(path.join(tmpdir(), 'anvil-e2e-'));
cpSync(path.join(root, 'test/fixtures/mini-repo'), workspace, { recursive: true });
// A Windows-style file, to check that writes keep CRLF line endings.
writeFileSync(path.join(workspace, 'crlf.py'), 'a = 1\r\nb = 2\r\nc = 3\r\n');

await runTests({
  extensionDevelopmentPath: root,
  extensionTestsPath: path.join(root, 'dist-test/index.js'),
  launchArgs: [workspace, '--disable-extensions', '--skip-welcome', '--skip-release-notes'],
  extensionTestsEnv: { ANVIL_E2E_WORKSPACE: workspace },
});

try {
  console.log(readFileSync(path.join(workspace, 'e2e-result.txt'), 'utf8'));
} catch {
  console.error('e2e: the suite did not run (VS Code exited without loading the tests).');
  process.exitCode = 1;
}
