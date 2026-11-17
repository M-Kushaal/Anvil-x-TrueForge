// Prompt and scope lock for inline edits. Pure.
import { locate } from '../drafts/locate';

export interface InlineRequest {
  path: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  instruction: string;
  /** Full text of the file as the agent will see it (LF). */
  text: string;
  language: string;
}

/** Lines of slack around the selection, so a model may touch e.g. a decorator just above it. */
const SCOPE_SLACK = 2;
const CONTEXT_LINES = 15;

export const INLINE_INSTRUCTIONS = [
  "You are Anvil's inline editor. The user selected code in their editor and asked for a change.",
  'Make exactly that change by calling propose_edit once on the given file.',
  '- `search` must be lines copied verbatim from the selected code (no line numbers), unique in the file.',
  '- `replace` holds the new lines with the same indentation.',
  '- Do not edit anything outside the selection. Do not reformat untouched lines.',
  '- If propose_edit is denied, read the reason, fix the call and try again.',
  'After the edit is staged, reply with one short sentence describing it.',
].join('\n');

export function buildInlinePrompt(req: InlineRequest): string {
  const lines = req.text.split('\n');
  const slice = (from: number, to: number) => lines.slice(Math.max(from, 0), Math.max(to, 0)).join('\n');
  const before = slice(req.startLine - 1 - CONTEXT_LINES, req.startLine - 1);
  const selected = slice(req.startLine - 1, req.endLine);
  const after = slice(req.endLine, req.endLine + CONTEXT_LINES);
  const fence = '```';
  return [
    `File: ${req.path} (selected lines ${req.startLine}-${req.endLine})`,
    `Instruction: ${req.instruction}`,
    '',
    'Selected code (the only lines you may change):',
    `${fence}${req.language}`,
    selected,
    fence,
    '',
    'Context before the selection (read-only):',
    `${fence}${req.language}`,
    before || '(start of file)',
    fence,
    'Context after the selection (read-only):',
    `${fence}${req.language}`,
    after || '(end of file)',
    fence,
  ].join('\n');
}

/** Returns a denial reason if an edit's `search` falls outside the selected lines. */
export function scopeViolation({ text, search, startLine, endLine }: { text: string; search: string; startLine: number; endLine: number }): string | undefined {
  const found = locate(text, search.replace(/\r\n/g, '\n'));
  if (!found.ok) return undefined; // the normal validation reports this more precisely
  const first = text.slice(0, found.start).split('\n').length;
  const last = first + text.slice(found.start, found.end).replace(/\n$/, '').split('\n').length - 1;
  if (first >= startLine - SCOPE_SLACK && last <= endLine + SCOPE_SLACK) return undefined;
  return `Error: this edit touches lines ${first}-${last}, outside the user's selection (lines ${startLine}-${endLine}). Only change the selected lines.`;
}
