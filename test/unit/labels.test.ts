import { describe, expect, it } from 'vitest';
import { toolLabel } from '../../src/shared/labels';

describe('toolLabel', () => {
  it('follows the row: ongoing while running, a question while waiting, past when done', () => {
    const args = JSON.stringify({ command: 'pytest -q' });
    expect(toolLabel('run_command', args, 'running')).toEqual({ verb: 'Running', target: 'pytest -q' });
    expect(toolLabel('run_command', args, 'waiting').verb).toBe('Wants to run');
    expect(toolLabel('run_command', args, 'done').verb).toBe('Ran');
  });

  it('calls an edit a proposal, never "Edited": nothing is written until the user keeps it', () => {
    expect(toolLabel('propose_edit', JSON.stringify({ path: 'a.py' }), 'done')).toEqual({ verb: 'Proposed an edit to', target: 'a.py' });
  });
});
