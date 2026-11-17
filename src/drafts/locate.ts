// Finds the one place an edit's `search` text applies. Exact match first, then a match that
// ignores trailing whitespace per line (a common model slip). Errors say how to fix the call.

export type Located = { ok: true; start: number; end: number } | { ok: false; error: string };

export function locate(text: string, search: string): Located {
  if (!search) return { ok: false, error: 'Error: `search` is empty. Copy the exact lines to replace from read_file output (without line numbers).' };

  const exact = occurrences(text, search);
  if (exact.length === 1) return { ok: true, start: exact[0]!, end: exact[0]! + search.length };
  if (exact.length > 1) {
    return { ok: false, error: `Error: \`search\` matches ${exact.length} places (lines ${exact.map((i) => lineOf(text, i)).join(', ')}). Include more surrounding lines so it is unique.` };
  }

  const loose = looseMatch(text, search);
  if (loose) return loose;
  return { ok: false, error: `Error: \`search\` was not found in the file. ${closestHint(text, search)}Re-read the file and copy the lines exactly.` };
}

function occurrences(text: string, search: string): number[] {
  const found: number[] = [];
  for (let i = text.indexOf(search); i !== -1; i = text.indexOf(search, i + 1)) found.push(i);
  return found;
}

/** Line-block match ignoring trailing whitespace; must be unique. */
function looseMatch(text: string, search: string): Located | undefined {
  const lines = text.split('\n');
  const want = search.replace(/\n$/, '').split('\n').map((l) => l.trimEnd());
  if (want.length === 0) return undefined;
  const starts: number[] = [];
  for (let i = 0; i + want.length <= lines.length; i++) {
    if (want.every((w, j) => lines[i + j]!.trimEnd() === w)) starts.push(i);
  }
  if (starts.length !== 1) return undefined;
  const first = starts[0]!;
  const start = lines.slice(0, first).reduce((n, l) => n + l.length + 1, 0);
  const blockLength = lines.slice(first, first + want.length).join('\n').length;
  const end = start + blockLength + (search.endsWith('\n') && first + want.length < lines.length ? 1 : 0);
  return { ok: true, start, end };
}

function closestHint(text: string, search: string): string {
  const needle = search.split('\n').map((l) => l.trim()).find(Boolean);
  if (!needle) return '';
  const lines = text.split('\n');
  let best = -1;
  let bestScore = 0;
  lines.forEach((line, i) => {
    const score = similarity(line.trim(), needle);
    if (score > bestScore) { bestScore = score; best = i; }
  });
  return best >= 0 && bestScore > 0.5 ? `Closest line is L${best + 1}: \`${lines[best]!.trim().slice(0, 100)}\`. ` : '';
}

/** Share of `b`'s characters in the longest common prefix/suffix with `a`; cheap and good enough for hints. */
function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  return (prefix + suffix) / Math.max(a.length, b.length);
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}
