import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkspace, isIndexablePath, isSecretPath, withoutSecrets } from '../../src/workspace/workspace';

const cache = path.resolve(__dirname, '../../.cache');
const created: string[] = [];
function fixture() {
  mkdirSync(cache, { recursive: true });
  const dir = mkdtempSync(path.join(cache, 'boundary-'));
  created.push(dir);
  const root = path.join(dir, 'project');
  const outside = path.join(dir, 'outside');
  mkdirSync(root); mkdirSync(outside);
  return { root, outside };
}
afterEach(() => { for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('workspace boundaries', () => {
  it('rejects existing files and new paths reached through an outside junction', async () => {
    const { root, outside } = fixture();
    writeFileSync(path.join(outside, 'data.txt'), 'private');
    symlinkSync(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const ws = createWorkspace({ root });
    expect(() => ws.resolve('linked/data.txt')).toThrow(/outside the workspace/);
    expect(() => ws.resolve('linked/new/file.txt')).toThrow(/outside the workspace/);
    await expect(ws.read('linked/data.txt')).rejects.toThrow(/outside the workspace/);
    expect(await ws.files()).toEqual([]);
  });

  it('rejects a harmless-looking alias to a credential directory inside the project', () => {
    const { root } = fixture();
    mkdirSync(path.join(root, '.aws'));
    symlinkSync(path.join(root, '.aws'), path.join(root, 'settings'), process.platform === 'win32' ? 'junction' : 'dir');
    const ws = createWorkspace({ root });
    expect(() => ws.resolve('settings/new-config')).toThrow(/credentials/);
    expect(() => ws.resolve('.aws/credentials')).toThrow(/credentials/);
    expect(ws.resolve('src/new.py')).toBe(path.join(root, 'src/new.py'));
  });

  it('rejects absolute paths and ambiguous Windows aliases', () => {
    const { root } = fixture();
    const ws = createWorkspace({ root });
    expect(() => ws.resolve(path.join(root, 'file.txt'))).toThrow(/relative to the workspace/);
    if (process.platform === 'win32') {
      for (const rel of ['.env.', '.env ', 'src/file.txt:private', 'src/CON.txt']) expect(() => ws.resolve(rel), rel).toThrow(/unsupported Windows path/);
    }
  });

  it('uses the same exclusions for discovery and incremental indexing', () => {
    for (const p of ['node_modules/x.ts', 'dist/x.js', '.cache/a.py', '.env', 'keys/server.pem', '.ssh/config', '../out.py', 'logo.png']) {
      expect(isIndexablePath(p), p).toBe(false);
    }
    for (const p of ['src/app.py', '.github/workflows/ci.yml', 'docs/keys.md']) expect(isIndexablePath(p), p).toBe(true);
    expect(isSecretPath('project/.aws/config')).toBe(true);
    expect(isSecretPath('src/keys.py')).toBe(false);
  });

  it('drops credential variables with prefixes and suffixes without dropping ordinary settings', () => {
    expect(withoutSecrets({ AWS_SECRET_ACCESS_KEY: 'x', TOKEN_BACKUP: 'x', MY_API_KEY_FILE: 'x', GOOGLE_APPLICATION_CREDENTIALS: 'x', PATH: 'p', KEYBOARD_LAYOUT: 'de' }))
      .toEqual({ PATH: 'p', KEYBOARD_LAYOUT: 'de' });
  });
});
