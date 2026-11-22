// Edit tools stage changes in the draft layer; nothing reaches disk until the user keeps it.
// TrueForge gates both behind tool approval; Anvil's approval handler validates with the same
// DraftStore.check() so a bad edit is denied with a precise reason before it is ever staged.
import { z } from 'zod';
import type { DraftStore, StageResult } from '../drafts/store';
import { defineTool, type Tool } from './tool';
import { plural } from '../shared/text';

export interface EditContext {
  generation?: () => number;
  authorize?: (name: string, args: string, onStaged: () => void) => () => void;
  drafts: DraftStore;
  /** Real file text (live buffer or disk), or undefined if the file does not exist. */
  realText(path: string): Promise<string | undefined>;
  /** Model currently driving the run, recorded on each draft. */
  model(): string;
  /**
   * The one spelling of a workspace path (`./src\x.py` → `src/x.py`), so aliases never become two
   * drafts. Throws for paths outside the workspace.
   */
  normalize?(path: string): string;
}

/** The path as the draft store keys it. */
const keyOf = (ctx: EditContext, path: string): string => (ctx.normalize ? ctx.normalize(path) : path);

export const EDIT_TOOL_NAMES = ['propose_edit', 'create_file'] as const;

const proposeEditInput = {
  path: z.string().describe('Workspace-relative path of an existing file'),
  search: z.string().describe('Exact lines to replace, copied from read_file output without line numbers. Must match exactly once.'),
  replace: z.string().describe('The new lines that replace `search`'),
  why: z.string().optional().describe('One short sentence on why this change is needed'),
};

const createFileInput = {
  path: z.string().describe('Workspace-relative path of a file that does not exist yet'),
  content: z.string().describe('Full content of the new file'),
};

export function editTools(ctx: EditContext): Tool[] {
  return [
    defineTool({
      name: 'propose_edit',
      description: 'Propose a change to an existing file as a search/replace pair. The change is staged for the user to review hunk by hunk; it is not written yet. Later edits see earlier staged ones. Keep `search` small but unique.',
      input: proposeEditInput,
      annotations: { destructiveHint: true },
      run: async ({ path: raw, search, replace }) => {
        const path = keyOf(ctx, raw);
        return describe(path, ctx.drafts.stage({ path, search, replace, model: ctx.model() }, await ctx.realText(path)));
      },
    }),
    defineTool({
      name: 'create_file',
      description: 'Propose a new file. Staged for review like propose_edit; fails if the file exists.',
      input: createFileInput,
      annotations: { destructiveHint: true },
      run: async ({ path: raw, content }) => {
        const path = keyOf(ctx, raw);
        return describe(path, ctx.drafts.createFile({ path, content, exists: (await ctx.realText(path)) !== undefined, model: ctx.model() }));
      },
    }),
  ];
}

/** Validates an edit call without staging it. Returns an error message, or undefined if valid. */
export async function validateEdit(ctx: EditContext, name: string, argsJson: string): Promise<string | undefined> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argsJson || '{}') as Record<string, unknown>;
  } catch {
    return 'Error: arguments are not valid JSON.';
  }
  if (typeof args.path !== 'string' || !args.path) return 'Error: `path` is required.';
  let path: string;
  try {
    path = keyOf(ctx, args.path);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const real = await ctx.realText(path).catch(() => undefined);
  if (name === 'create_file') {
    return real !== undefined || ctx.drafts.get(path) ? `Error: ${path} already exists. Use propose_edit to change it.` : undefined;
  }
  const result = ctx.drafts.check({ path, search: String(args.search ?? ''), replace: String(args.replace ?? ''), model: ctx.model() }, real);
  return result.ok ? undefined : result.error;
}

/** True for the first line of a successful propose_edit / create_file result. */
export const isPendingSummary = (line: string): boolean => / · pending \+\d+ −\d+$/.test(line);

function describe(path: string, result: StageResult): string {
  if (!result.ok) return result.error;
  return [
    `${path} · pending +${result.added} −${result.removed}`,
    `${plural(result.pending, 'pending hunk')} in this file. Not written yet: the user reviews it. Read ${path} again to see the staged version before editing it further.`,
  ].join('\n');
}
