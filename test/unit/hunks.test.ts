import { describe, expect, it } from 'vitest';
import { applyHunks, diffHunks, mapLine } from '../../src/drafts/hunks';

/** Deterministic pseudo-random generator so failures are reproducible. */
function rng(seed: number) {
  return () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

function mutate(text: string, random: () => number): string {
  const lines = text.split('\n');
  for (let k = 0; k < 4; k++) {
    const i = Math.floor(random() * (lines.length + 1));
    const op = random();
    if (op < 0.33) lines.splice(i, 0, `added ${k}`);
    else if (op < 0.66) lines.splice(i, 1);
    else if (i < lines.length) lines[i] = `${lines[i]} changed`;
  }
  return lines.join('\n');
}

describe('diffHunks / applyHunks', () => {
  it('finds separate hunks for separate changes', () => {
    const hunks = diffHunks('a\nb\nc\nd\ne', 'a\nB\nc\nd\nE\nF');
    expect(hunks.map((h) => [h.oldStart, h.oldLines, h.newLines])).toEqual([
      [1, ['b'], ['B']],
      [4, ['e'], ['E', 'F']],
    ]);
  });

  it('gives stable ids for the same change', () => {
    expect(diffHunks('a\nb', 'a\nX')[0]!.id).toBe(diffHunks('a\nb', 'a\nX')[0]!.id);
  });

  it('property: all hunks → new text, none → old text, any subset is consistent', () => {
    const random = rng(42);
    for (let round = 0; round < 300; round++) {
      const before = Array.from({ length: 3 + Math.floor(random() * 12) }, (_, i) => `line ${i}`).join('\n');
      const after = mutate(before, random);
      const hunks = diffHunks(before, after);
      expect(applyHunks(before, hunks)).toBe(after);
      expect(applyHunks(before, hunks, () => false)).toBe(before);
      const keep = new Set(hunks.filter(() => random() < 0.5).map((h) => h.id));
      const partial = applyHunks(before, hunks, (h) => keep.has(h.id));
      // Keeping the rest afterwards must land exactly on `after`.
      expect(applyHunks(partial, diffHunks(partial, after))).toBe(after);
      // And the remaining diff is exactly the hunks we skipped.
      expect(diffHunks(partial, after).length).toBe(hunks.length - keep.size);
    }
  });
});

describe('mapLine', () => {
  it('follows lines shifted by edits above them', () => {
    expect(mapLine('a\nb\nc', 'x\ny\na\nb\nc', 2)).toBe(4);
    expect(mapLine('a\nb\nc', 'b\nc', 2)).toBe(1);
  });
});
