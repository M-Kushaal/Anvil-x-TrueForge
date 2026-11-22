// Line-level hunks between two texts, and applying any subset of them. Pure.
import { diffArrays } from 'diff';

export interface Hunk {
  /** Stable for the same change at the same place: `${oldStart}:${oldCount}:${hash}`. */
  id: string;
  /** 0-based line index in the old text where the hunk starts. */
  oldStart: number;
  /** 0-based line index in the new text where the hunk starts. */
  newStart: number;
  oldLines: string[];
  newLines: string[];
}

export const splitLines = (text: string): string[] => text.split('\n');
export const joinLines = (lines: string[]): string => lines.join('\n');

export function diffHunks(before: string, after: string): Hunk[] {
  const hunks: Hunk[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  let open: Hunk | undefined;
  for (const part of diffArrays(splitLines(before), splitLines(after))) {
    const count = part.value.length;
    if (!part.added && !part.removed) {
      if (open) hunks.push(finalize(open));
      open = undefined;
      oldIndex += count;
      newIndex += count;
      continue;
    }
    open ??= { id: '', oldStart: oldIndex, newStart: newIndex, oldLines: [], newLines: [] };
    if (part.removed) {
      open.oldLines.push(...part.value);
      oldIndex += count;
    } else {
      open.newLines.push(...part.value);
      newIndex += count;
    }
  }
  if (open) hunks.push(finalize(open));
  return hunks;
}

/** Applies the hunks for which `include` is true; the rest keep the old text. */
export function applyHunks(before: string, hunks: Hunk[], include: (hunk: Hunk) => boolean = () => true): string {
  const lines = splitLines(before);
  // Bottom-up so earlier indices stay valid.
  for (const hunk of [...hunks].sort((a, b) => b.oldStart - a.oldStart)) {
    if (include(hunk)) lines.splice(hunk.oldStart, hunk.oldLines.length, ...hunk.newLines);
  }
  return joinLines(lines);
}

/** Counts of added and removed lines. */
export function stats(hunks: Hunk[]): { added: number; removed: number } {
  return hunks.reduce((acc, h) => ({ added: acc.added + h.newLines.length, removed: acc.removed + h.oldLines.length }), { added: 0, removed: 0 });
}

function finalize(hunk: Hunk): Hunk {
  return { ...hunk, id: `${hunk.oldStart}:${hunk.oldLines.length}:${hash(hunk.newLines.join('\n'))}` };
}

function hash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}
