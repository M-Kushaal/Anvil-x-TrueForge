// Review flow inside real VS Code: staged edits never touch disk until Keep; Keep writes one hunk;
// Reject drops a change; Revert restores a kept one; CodeLens appears per change; CRLF files keep their line endings.
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import type { AnvilApi } from '../../src/extension';
import { proposalUri } from '../../src/review/review';

const ws = process.env.ANVIL_E2E_WORKSPACE ?? '';
const disk = (rel: string) => readFileSync(path.join(ws, rel), 'utf8');
const MODEL = 'test-model';

export function registerReviewTests(): void {
  let api: AnvilApi;

  suite('Anvil review (e2e)', () => {
    suiteSetup(async () => {
      const ext = vscode.extensions.getExtension<AnvilApi | undefined>('anvil-forgeathon.anvil');
      assert.ok(ext, 'extension found');
      const exported = await ext.activate();
      assert.ok(exported, 'extension activated on the workspace');
      api = exported;
    });

    teardown(() => api.drafts.discardAll());

    test('staging does not touch disk', () => {
      const before = disk('src/app/config.py');
      stageTwo(api);
      assert.equal(api.drafts.pending('src/app/config.py').length, 2);
      assert.equal(disk('src/app/config.py'), before);
    });

    test('proposal document shows Keep / Reject CodeLens for each change', async () => {
      stageTwo(api);
      await api.review.open('src/app/config.py');
      const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', proposalUri('src/app/config.py'));
      const titles = lenses.map((l) => l.command?.title ?? '');
      assert.equal(titles.filter((t) => t.includes('Keep')).length, 2);
      assert.equal(titles.filter((t) => t.includes('Reject')).length, 2);
      assert.ok(titles.includes('1 of 2 · +1 −1'));
    });

    test('Keep writes exactly one hunk; the other stays pending; undo restores', async () => {
      const original = disk('src/app/config.py');
      stageTwo(api);
      const [first] = api.drafts.pending('src/app/config.py');
      await vscode.commands.executeCommand('anvil.keepHunk', 'src/app/config.py', first!.id);
      const afterKeep = disk('src/app/config.py');
      assert.ok(afterKeep.includes('Works like a dict, with loaders.'), 'first hunk written');
      assert.ok(afterKeep.includes('return True'), 'second hunk not written');
      assert.equal(api.drafts.pending('src/app/config.py').length, 1);

      await vscode.commands.executeCommand('anvil.undoLastApply');
      assert.equal(disk('src/app/config.py'), original);
      assert.equal(api.drafts.pending('src/app/config.py').length, 2, 'undone change is pending again');
    });

    test('Reject drops a change without writing anything', async () => {
      const original = disk('src/app/config.py');
      stageTwo(api);
      const [, second] = api.drafts.pending('src/app/config.py');
      await vscode.commands.executeCommand('anvil.undoHunk', 'src/app/config.py', second!.id);
      assert.equal(api.drafts.pending('src/app/config.py').length, 1);
      assert.equal(disk('src/app/config.py'), original);
    });

    test('Keep all on a CRLF file keeps CRLF line endings', async () => {
      api.drafts.stage({ path: 'crlf.py', search: 'b = 2', replace: 'b = 20\nb2 = 21', model: MODEL }, 'a = 1\nb = 2\nc = 3\n');
      await vscode.commands.executeCommand('anvil.keepFile', 'crlf.py');
      assert.equal(disk('crlf.py'), 'a = 1\r\nb = 20\r\nb2 = 21\r\nc = 3\r\n');
      await vscode.commands.executeCommand('anvil.undoLastApply');
      assert.equal(disk('crlf.py'), 'a = 1\r\nb = 2\r\nc = 3\r\n');
    });

    test('new files are created only on Keep and removed by undo', async () => {
      api.drafts.createFile({ path: 'src/app/new_module.py', content: 'VALUE = 1\n', exists: false, model: MODEL });
      assert.throws(() => disk('src/app/new_module.py'));
      await vscode.commands.executeCommand('anvil.keepFile', 'src/app/new_module.py');
      assert.equal(disk('src/app/new_module.py'), 'VALUE = 1\n');
      await vscode.commands.executeCommand('anvil.undoLastApply');
      assert.throws(() => disk('src/app/new_module.py'));
    });
  });
}

function stageTwo(api: AnvilApi): void {
  const real = disk('src/app/config.py').replace(/\r\n/g, '\n');
  api.drafts.stage({ path: 'src/app/config.py', search: '    """Works exactly like a dict but provides ways to fill it from files."""', replace: '    """Works like a dict, with loaders."""', model: MODEL }, real);
  api.drafts.stage({ path: 'src/app/config.py', search: '        return True', replace: '        return self', model: MODEL }, real);
}
