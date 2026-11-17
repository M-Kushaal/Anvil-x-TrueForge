// Approved commands execute on a snapshot of the workspace. Cancellation includes copy preparation.
import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { DraftStore } from '../drafts/store';
import { plural } from '../shared/text';
import { IGNORED_DIRS, isSecretPath, withoutSecrets, type Workspace } from '../workspace/workspace';
import { defineTool, type Tool } from './tool';

export interface CommandResult {
  command: string;
  code: number | null;
  output: string;
  cancelled: boolean;
  timedOut: boolean;
  snapshotId?: string;
}

export interface CommandContext {
  ws: Workspace;
  drafts: DraftStore;
  extraPath: () => string[];
  /** Unsaved buffers captured before preparation. Staged drafts take precedence. */
  snapshot?: () => Array<{ path: string; text: string }>;
  snapshotId?: () => string;
  onResult?: (result: CommandResult) => void;
}

const MAX_OUTPUT_LINES = 60;
const MAX_OUTPUT_BYTES = 128 * 1024;
const running = new Set<AbortController>();

/** Stops preparing commands as well as commands that already have a child process. */
export function killRunningCommands(): number {
  const count = running.size;
  for (const controller of running) controller.abort();
  return count;
}

/** Wait for the platform tree-kill command; fall back if it cannot be launched or fails. */
function killTree(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null) return Promise.resolve();
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    const killer = spawn(executable, ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    let done = false;
    const finish = (failed: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (failed) child.kill('SIGKILL');
      resolve();
    };
    const timer = setTimeout(() => { killer.kill(); finish(true); }, 3000);
    killer.once('error', () => finish(true));
    killer.once('close', (code) => finish(code !== 0));
  });
}

/** Legacy classifier only. Test/help commands still execute code and require explicit approval. */
export function isSafeCommand(command: string): boolean {
  const c = command.trim();
  if (/[\r\n;&|`$<>]/.test(command)) return false;
  return /^(python3?\s+-m\s+)?(pytest|py\.test)(\s|$)/.test(c)
    || /^(npm|pnpm|yarn)\s+(test|run\s+test)(\s|$)/.test(c)
    || /^[\w.-]+(\s+[\w-]+)*\s+(--help|-h|--version)$/.test(c);
}

export function commandTools(ctx: CommandContext): Tool[] {
  return [defineTool({
    name: 'run_command',
    description: 'Run an approved shell command in a temporary copy with unsaved buffers and staged edits. This is not a sandbox: commands have your machine permissions. Output is bounded to the last lines.',
    input: {
      command: z.string().describe('e.g. "python -m pytest tests/test_app.py -q" or "npm test"'),
      timeout_seconds: z.number().int().min(1).max(300).optional(),
    },
    annotations: { destructiveHint: true },
    run: async ({ command, timeout_seconds }) => {
      const started = Date.now();
      const controller = new AbortController();
      running.add(controller); // register before the first await, including copy preparation
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, (timeout_seconds ?? 120) * 1000);
      let dir: string | undefined;
      let snapshotId: string | undefined;
      let result: CommandResult;
      let staged = 0;
      try {
        snapshotId = ctx.snapshotId?.();
        const drafts = ctx.drafts.all().map((draft) => ({ path: draft.path, text: draft.proposed }));
        staged = drafts.length;
        const overlays = [...(ctx.snapshot?.() ?? []).map((file) => ({ ...file })), ...drafts];
        const extraPath = ctx.extraPath();
        dir = await fs.mkdtemp(path.join(tmpdir(), 'anvil-run-'));
        await shadowCopy(ctx.ws, dir, overlays, controller.signal);
        controller.signal.throwIfAborted();
        const execution = await exec(command, dir, extraPath, controller.signal);
        result = { command, ...execution, cancelled: controller.signal.aborted && !timedOut, timedOut, snapshotId };
      } catch (error) {
        result = {
          command, code: null, output: controller.signal.aborted ? '' : String(error),
          cancelled: controller.signal.aborted && !timedOut, timedOut, snapshotId,
        };
      } finally {
        clearTimeout(timer);
        running.delete(controller);
        if (dir) await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined);
      }
      ctx.onResult?.(result);
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      const where = staged ? `a copy with ${plural(staged, 'staged file')}` : 'a copy of the workspace';
      const failed = result.code !== 0 || result.cancelled || result.timedOut;
      const reason = result.timedOut ? ' · timed out' : result.cancelled ? ' · cancelled' : '';
      return [`${failed ? 'Error: ' : ''}${command} · exit ${result.code ?? 'killed'}${reason} · ${secs}s (ran on ${where})`, tail(result.output)].join('\n');
    },
  })];
}

async function shadowCopy(ws: Workspace, dir: string, overlays: Array<{ path: string; text: string }>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await fs.cp(ws.root, dir, {
    recursive: true,
    // Never preserve symlinks/junctions into the original tree or outside the workspace.
    filter: async (src) => {
      signal.throwIfAborted();
      return src === ws.root || (!IGNORED_DIRS.has(path.basename(src)) && !isSecretPath(src) && !(await fs.lstat(src)).isSymbolicLink());
    },
  });
  for (const overlay of overlays) {
    signal.throwIfAborted();
    ws.resolve(overlay.path);
    const target = path.resolve(dir, overlay.path);
    if (!target.startsWith(dir + path.sep)) throw new Error('Snapshot path is outside the workspace');
    if (isSecretPath(overlay.path) || overlay.path.split(/[\\/]/).some((part) => IGNORED_DIRS.has(part))) continue;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, overlay.text);
  }
}

function exec(command: string, cwd: string, extraPath: string[], signal: AbortSignal): Promise<{ code: number | null; output: string }> {
  signal.throwIfAborted();
  return new Promise((resolve) => {
    const sep = path.delimiter;
    const env = {
      ...withoutSecrets(process.env),
      PATH: [...extraPath, process.env.PATH ?? ''].join(sep),
      PYTHONPATH: [path.join(cwd, 'src'), cwd, process.env.PYTHONPATH ?? ''].filter(Boolean).join(sep),
      PYTHONDONTWRITEBYTECODE: '1',
    };
    const child = spawn(command, { cwd, env, shell: true, windowsHide: true, detached: process.platform !== 'win32' });
    let output = Buffer.alloc(0);
    let truncated = false;
    let finished = false;
    let stopping = false;
    let killDeadline: ReturnType<typeof setTimeout> | undefined;
    const append = (data: Buffer) => {
      const combined = Buffer.concat([output, data]);
      if (combined.length > MAX_OUTPUT_BYTES) truncated = true;
      output = combined.subarray(Math.max(0, combined.length - MAX_OUTPUT_BYTES));
    };
    const finish = (code: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(killDeadline);
      signal.removeEventListener('abort', stop);
      resolve({ code, output: `${truncated ? '… earlier output truncated\n' : ''}${output.toString()}` });
    };
    const stop = () => {
      if (stopping || finished) return;
      stopping = true;
      // A failed platform tree kill must not leave Stop waiting forever on inherited pipes.
      killDeadline = setTimeout(() => {
        child.kill('SIGKILL');
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
        append(Buffer.from('\nProcess cleanup did not complete; a descendant may still be running.'));
        finish(null);
      }, 5000);
      void killTree(child);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.once('close', (code) => finish(signal.aborted ? null : code));
    child.once('error', (error) => { append(Buffer.from(String(error))); finish(-1); });
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
  });
}

function tail(output: string): string {
  const lines = output.replace(/\r\n/g, '\n').trimEnd().split('\n');
  return lines.length > MAX_OUTPUT_LINES ? [`… ${lines.length - MAX_OUTPUT_LINES} earlier lines`, ...lines.slice(-MAX_OUTPUT_LINES)].join('\n') : lines.join('\n');
}
