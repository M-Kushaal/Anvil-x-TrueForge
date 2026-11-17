import { describe, expect, it } from 'vitest';
import { buildInlinePrompt, scopeViolation } from '../../../src/inline/prompt';

const text = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n');

describe('inline prompt', () => {
  it('includes the instruction, the selected lines, and read-only context', () => {
    const prompt = buildInlinePrompt({ path: 'a.py', startLine: 20, endLine: 22, instruction: 'rename', text, language: 'python' });
    expect(prompt).toContain('File: a.py (selected lines 20-22)');
    expect(prompt).toContain('Instruction: rename');
    expect(prompt).toContain('```python\nline 20\nline 21\nline 22\n```');
    expect(prompt).toContain('line 5'); // 15 lines of context before
    expect(prompt).not.toContain('line 4\n');
  });

  it('marks the file edges when there is no context', () => {
    const prompt = buildInlinePrompt({ path: 'a.py', startLine: 1, endLine: 40, instruction: 'x', text, language: 'python' });
    expect(prompt).toContain('(start of file)');
    expect(prompt).toContain('(end of file)');
  });
});

describe('scope lock', () => {
  it('allows edits inside the selection (with two lines of slack)', () => {
    expect(scopeViolation({ text, search: 'line 21', startLine: 20, endLine: 22 })).toBeUndefined();
    expect(scopeViolation({ text, search: 'line 18', startLine: 20, endLine: 22 })).toBeUndefined();
  });

  it('denies edits outside the selection with a fixable reason', () => {
    expect(scopeViolation({ text, search: 'line 30', startLine: 20, endLine: 22 }))
      .toBe("Error: this edit touches lines 30-30, outside the user's selection (lines 20-22). Only change the selected lines.");
  });

  it('denies edits that start inside but run past the selection', () => {
    expect(scopeViolation({ text, search: 'line 21\nline 22\nline 23\nline 24\nline 25', startLine: 20, endLine: 22 })).toMatch(/lines 21-25/);
  });
});
