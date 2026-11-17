// Runs Graphify's offline code-graph build (`graphify update <root> --no-cluster`: AST only, no
// LLM). Output goes to Anvil's own storage via GRAPHIFY_OUT so the workspace stays clean, and every
// model-provider key is removed from its environment so it can never call a model.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { withoutSecrets } from '../workspace/workspace';
import { parseGraphify, type FileGraph } from './graph';

export async function buildGraph({ root, outDir, command = 'graphify', timeoutMs = 180_000 }: {
  root: string; outDir: string; command?: string; timeoutMs?: number;
}): Promise<{ graph?: FileGraph; message: string }> {
  mkdirSync(outDir, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...withoutSecrets(process.env), GRAPHIFY_OUT: outDir, GRAPHIFY_NO_TIPS: '1' };

  const result = await new Promise<{ ok: boolean; output: string }>((resolve) => {
    // No shell: paths with spaces stay intact, and nothing in the workspace path is interpreted.
    execFile(command, ['update', root, '--no-cluster'], { env, cwd: outDir, timeout: timeoutMs, windowsHide: true },
      (error, stdout, stderr) => resolve({ ok: !error, output: `${stdout}${stderr}` }));
  });
  const file = path.join(outDir, 'graph.json');
  const graph = loadGraph(file);
  if (graph) return { graph, message: result.ok ? 'Graphify code graph built.' : 'Using the last Graphify graph (rebuild failed).' };
  return { message: result.ok ? 'Graphify produced no graph.' : `Graphify unavailable (${firstLine(result.output)}). Using keyword search only. Install with: pip install graphifyy` };
}

export function loadGraph(file: string): FileGraph | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return parseGraphify(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return undefined;
  }
}

function firstLine(text: string): string {
  return (text.split('\n').find((l) => l.trim()) ?? 'not found').trim().slice(0, 120);
}
