// File access for the agent's tools. Plain Node so it is testable without VS Code; the extension
// passes `liveText` so tools see unsaved editor buffers instead of stale disk content.
import { promises as fs, lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

export const IGNORED_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', '.venv', 'venv', 'env', '__pycache__',
  '.mypy_cache', '.pytest_cache', '.tox', '.idea', '.vscode-test', 'graphify-out', 'coverage', '.next',
]);
const MAX_FILE_BYTES = 1_000_000;

/** Credentials the agent must never read or copy: .env files (not .env.example), private keys. */
export function isSecretPath(p: string): boolean {
  const parts = p.split(/[\\/]/);
  if (parts.some((part) => /^\.(aws|ssh|azure|gnupg)$/i.test(part))) return true;
  const name = parts.pop() ?? '';
  if (/^\.env(\..+)?$/i.test(name)) return !/\.(example|sample|template)$/i.test(name);
  return /\.(pem|key|p12|pfx)$/i.test(name) || /^id_(rsa|dsa|ecdsa|ed25519)$/i.test(name) || /^\.(npmrc|netrc|pypirc)$/i.test(name);
}

/** The environment without API keys, tokens and secrets, for processes Anvil starts. */
export function withoutSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !/(?:^|_)(?:API_KEY|ACCESS_KEY|PRIVATE_KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)(?:_|$)/i.test(key) && !/(?:KEY|TOKEN|SECRET|PASSWORD)$/i.test(key)));
}

/** Shared discovery and watcher policy; explicit file reads may still access hidden project files. */
export function isIndexablePath(p: string): boolean {
  const parts = p.replace(/\\/g, '/').replace(/^\.\//, '').split('/');
  return parts.length > 0 && parts.every((part) => part && part !== '..' && !IGNORED_DIRS.has(part)
    && (!part.startsWith('.') || part === '.github')) && !isSecretPath(p) && isTextLike(p);
}

export interface Workspace {
  readonly root: string;
  /** Resolves a workspace-relative path; throws if it escapes the root. */
  resolve(rel: string): string;
  read(rel: string): Promise<string>;
  list(rel: string): Promise<Array<{ name: string; dir: boolean }>>;
  /** All text-like files, workspace-relative with forward slashes. Cached until `invalidate`. */
  files(): Promise<string[]>;
  invalidate(): void;
}

export function createWorkspace({ root, liveText }: { root: string; liveText?: (abs: string) => string | undefined }): Workspace {
  const base = path.resolve(root);
  const realBase = realpathSync(base);
  let cache: Promise<string[]> | undefined;

  const resolve = (rel: string): string => {
    if (path.isAbsolute(rel)) throw new Error(`Error: path "${rel}" must be relative to the workspace`);
    // Windows interprets these as alternate streams, device names, or normalized aliases.
    // Reject ambiguous spellings before checking either lexical or canonical containment.
    if (process.platform === 'win32' && rel.split(/[\\/]/).some((part) => part !== '.' && part !== '..'
      && (/:/.test(part) || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))) {
      throw new Error(`Error: unsupported Windows path: ${rel}`);
    }
    const abs = path.resolve(base, rel);
    const inside = abs === base || abs.startsWith(base + path.sep);
    if (!inside) throw new Error(`Error: path "${rel}" is outside the workspace`);
    // Resolve the nearest existing ancestor as well as existing targets. This also protects
    // create_file("link/new/file") when link is a junction pointing outside the workspace.
    const canonical = canonicalTarget(abs);
    const relative = path.relative(realBase, canonical);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Error: path "${rel}" is outside the workspace (linked target)`);
    }
    if (isSecretPath(rel) || isSecretPath(relative)) throw new Error(`Error: ${rel} holds credentials; Anvil does not read or edit it.`);
    return abs;
  };

  return {
    root: base,
    resolve,
    async read(rel) {
      if (isSecretPath(rel)) throw new Error(`Error: ${rel} holds credentials; Anvil does not read it.`);
      const abs = resolve(rel);
      const live = liveText?.(abs);
      if (live !== undefined) return live;
      const stat = await fs.stat(abs).catch(() => undefined);
      if (!stat?.isFile()) throw new Error(`Error: file not found: ${rel}`);
      if (stat.size > MAX_FILE_BYTES) throw new Error(`Error: ${rel} is larger than 1 MB`);
      return (await fs.readFile(abs, 'utf8')).replace(/\r\n/g, '\n');
    },
    async list(rel) {
      const entries = await fs.readdir(resolve(rel), { withFileTypes: true }).catch(() => {
        throw new Error(`Error: directory not found: ${rel}`);
      });
      return entries
        .filter((e) => !IGNORED_DIRS.has(e.name) && !isSecretPath(path.join(rel, e.name)) && !e.isSymbolicLink())
        .map((e) => ({ name: e.name, dir: e.isDirectory() }))
        .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    },
    files() {
      cache ??= walk(base);
      return cache;
    },
    invalidate() {
      cache = undefined;
    },
  };
}

async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.github') continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) await visit(abs);
      } else if (entry.isFile()) {
        const rel = path.relative(root, abs).split(path.sep).join('/');
        if (isIndexablePath(rel)) out.push(rel);
      }
    }
  };
  await visit(root);
  return out.sort();
}

/** Fails closed on inaccessible and broken links rather than treating them as new files. */
function canonicalTarget(target: string): string {
  try {
    return realpathSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try {
      if (lstatSync(target).isSymbolicLink()) throw new Error(`Error: unresolved link: ${target}`);
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError;
    }
    const parent = path.dirname(target);
    if (parent === target) throw error;
    return path.join(canonicalTarget(parent), path.basename(target));
  }
}

const BINARY_EXT = /\.(png|jpe?g|gif|ico|webp|pdf|zip|gz|tar|whl|exe|dll|so|dylib|pyc|woff2?|ttf|mp4|mp3|db|sqlite|lock)$/i;

function isTextLike(name: string): boolean {
  return !BINARY_EXT.test(name);
}
