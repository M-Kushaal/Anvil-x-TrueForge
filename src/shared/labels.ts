// Turns a tool call into the one-line "Verb target" shown in the timeline.

/** [while running, when done]. Edits are proposals until kept, so "Proposed", never "Edited". */
const VERBS: Record<string, [string, string]> = {
  read_file: ['Reading', 'Read'],
  list_dir: ['Listing', 'Listed'],
  search_code: ['Searching', 'Searched'],
  find_symbol: ['Finding', 'Found'],
  outline: ['Outlining', 'Outlined'],
  related_files: ['Finding files related to', 'Found files related to'],
  propose_edit: ['Proposing an edit to', 'Proposed an edit to'],
  create_file: ['Proposing new file', 'Proposed new file'],
  run_command: ['Running', 'Ran'],
  update_plan: ['Updating the plan', 'Updated the plan'],
  ask_user_question: ['Asking', 'Asked'],
};

/** While a tool waits for the user's OK it is a question, not a deed. */
const WAITING: Record<string, string> = { run_command: 'Wants to run', propose_edit: 'Wants to edit', create_file: 'Wants to create' };

/** Argument that best names what a tool acted on, in priority order. */
const TARGET_KEYS = ['path', 'query', 'name', 'command', 'question'];

export interface ToolLabel {
  verb: string;
  target: string;
}

export function toolLabel(name: string, argsJson: string, status: 'running' | 'waiting' | 'done' | 'error' | 'stopped' = 'done'): ToolLabel {
  const [running, done] = VERBS[name] ?? [humanize(name), humanize(name)];
  const verb = status === 'waiting' ? WAITING[name] ?? running : status === 'running' ? running : done;
  const args = parseArgs(argsJson);
  const key = TARGET_KEYS.find((k) => typeof args[k] === 'string' && args[k] !== '');
  const raw = key ? String(args[key]) : '';
  const target = key === 'query' ? `"${raw}"` : raw;
  return { verb, target: truncate(target, 80) };
}

function parseArgs(json: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(json || '{}');
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch {
    return {}; // arguments may still be streaming in
  }
}

function humanize(name: string): string {
  const words = name.replace(/[_-]+/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : 'Tool';
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
