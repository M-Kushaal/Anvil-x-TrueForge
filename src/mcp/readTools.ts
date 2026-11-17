// Read-only tools: capped, line-numbered output that tells the model how to get more.
import { z } from 'zod';
import type { Workspace } from '../workspace/workspace';
import { globToRegExp } from '../workspace/glob';
import { defineTool, type Tool } from './tool';
import { plural } from '../shared/text';

const READ_WINDOW = 100;
const READ_MAX = 250;
const SEARCH_MAX_HITS = 50;

export function readTools(ws: Workspace): Tool[] {
  return [
    defineTool({
      name: 'read_file',
      description: `Read a workspace file with line numbers. Returns ${READ_WINDOW} lines by default (max ${READ_MAX}); use start/end to page.`,
      input: {
        path: z.string().describe('Workspace-relative path, e.g. src/app/main.py'),
        start: z.number().int().min(1).optional().describe('First line (1-based)'),
        end: z.number().int().min(1).optional().describe('Last line, inclusive'),
        // Names models often use instead; accepted so a call is not silently misread.
        line_start: z.number().int().min(1).optional(),
        line_end: z.number().int().min(1).optional(),
        start_line: z.number().int().min(1).optional(),
        end_line: z.number().int().min(1).optional(),
      },
      annotations: { readOnlyHint: true },
      run: async ({ path, start, end, line_start, line_end, start_line, end_line }) =>
        readWindow({ text: await ws.read(path), path, start: start ?? line_start ?? start_line, end: end ?? line_end ?? end_line }),
    }),
    defineTool({
      name: 'list_dir',
      description: 'List a workspace directory (directories first).',
      input: { path: z.string().default('.').describe('Workspace-relative directory') },
      annotations: { readOnlyHint: true },
      run: async ({ path }) => {
        const entries = await ws.list(path);
        const shown = entries.slice(0, 200).map((e) => (e.dir ? `${e.name}/` : e.name));
        return [`${path} · ${entries.length} entries`, ...shown, ...(entries.length > 200 ? ['… truncated'] : [])].join('\n');
      },
    }),
    defineTool({
      name: 'search_code',
      description: `Search file contents (case-insensitive, literal unless regex=true). Narrow it with path (a file or folder) or glob (e.g. "*.py", "docs/**"). Over ${SEARCH_MAX_HITS} hits is refused as too broad.`,
      input: {
        query: z.string().min(1),
        path: z.string().optional().describe('Only this file or folder, e.g. "docs/guide.md" or "src/app"'),
        glob: z.string().optional(),
        regex: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
      run: async ({ query, path, glob, regex }) => formatSearch(query, await searchFiles({ ws, query, glob, regex: regex ?? false, within: path })),
    }),
  ];
}

export function readWindow({ text, path, start, end }: { text: string; path: string; start?: number; end?: number }): string {
  // A trailing newline ends the last line; it does not start a new one (matches editors).
  const lines = (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
  const from = Math.min(start ?? 1, Math.max(lines.length, 1));
  const to = Math.min(end ?? from + READ_WINDOW - 1, from + READ_MAX - 1, lines.length);
  const width = String(to).length;
  const body = lines.slice(from - 1, to).map((line, i) => `${String(from + i).padStart(width)}│${line}`);
  const more = lines.length - to;
  return [
    `${path} · lines ${from}–${to} of ${lines.length}`,
    ...body,
    ...(more > 0 ? [`… ${more} more lines. Call read_file with start=${to + 1} to continue.`] : []),
  ].join('\n');
}

interface Hit {
  path: string;
  line: number;
  text: string;
  context: string[];
}

async function searchFiles({ ws, query, glob, regex, within }: { ws: Workspace; query: string; glob?: string; regex: boolean; within?: string }): Promise<{ hits: Hit[]; files: number }> {
  const filter = glob ? globToRegExp(glob) : undefined;
  const scope = within?.replace(/^\.?\/+/, '').replace(/\/+$/, '');
  const matcher = regex ? new RegExp(query, 'i') : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const hits: Hit[] = [];
  let files = 0;
  for (const path of await ws.files()) {
    if (filter && !filter.test(path)) continue;
    if (scope && scope !== '.' && path !== scope && !path.startsWith(`${scope}/`)) continue;
    const text = await ws.read(path).catch(() => '');
    const lines = text.split('\n');
    let matched = false;
    lines.forEach((line, i) => {
      if (!matcher.test(line)) return;
      matched = true;
      hits.push({ path, line: i + 1, text: line.trim().slice(0, 160), context: lines.slice(Math.max(0, i - 2), i + 3) });
    });
    if (matched) files++;
  }
  return { hits, files };
}

function formatSearch(query: string, { hits, files }: { hits: Hit[]; files: number }): string {
  const header = `"${query}" · ${plural(hits.length, 'hit')} in ${plural(files, 'file')}`;
  if (hits.length === 0) return `${header}\nNo matches. Try a shorter query, a synonym, or find_symbol.`;
  if (hits.length > SEARCH_MAX_HITS) {
    const perFile = new Map<string, number>();
    for (const h of hits) perFile.set(h.path, (perFile.get(h.path) ?? 0) + 1);
    const top = [...perFile].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([p, n]) => `  ${p} (${n})`);
    return [`${header}: too broad, refine the query or add a glob`, 'Top files:', ...top].join('\n');
  }
  if (hits.length <= 3) {
    return [header, ...hits.flatMap((h) => [`${h.path}:${h.line}`, ...h.context.map((l) => `  ${l}`), ''])].join('\n').trimEnd();
  }
  const out = [header];
  let current = '';
  for (const h of hits) {
    if (h.path !== current) out.push((current = h.path));
    out.push(`  L${h.line}  ${h.text}`);
  }
  return out.join('\n');
}
