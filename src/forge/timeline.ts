// Pure reducer: TrueForge turn events (with deltas already merged) → chat timeline rows.
import type { ChatState, RowStatus, TimelineItem } from '../shared/protocol';

/** The fields of a TrueForge event this reducer reads. Everything else is ignored. */
export interface ForgeEvent {
  type: string;
  id: string;
  threadId?: string | null;
  content?: unknown;
  toolCalls?: unknown;
  toolCallId?: string;
  title?: string;
  state?: { status?: string; message?: string; reason?: string; metrics?: { totalTokens?: number; totalInputTokens?: number; totalOutputTokens?: number } };
}

interface ToolCall {
  id: string;
  function?: { name?: string; arguments?: string };
  toolInfo?: { name?: string };
}

/** Harness plumbing that would only add noise to the timeline. Subagents get their own thread row. */
const HIDDEN_TOOLS = new Set(['create_sub_agent', 'list_tools', 'get_tool_info', 'get_tool_output_schema', 'update_plan']);

export function initialState(model: string): ChatState {
  return { title: 'New chat', items: [], running: false, model, changes: [] };
}

export function applyEvent(state: ChatState, event: ForgeEvent): ChatState {
  const threadId = event.threadId ?? 'main';
  switch (event.type) {
    case 'model.message':
      return { ...state, items: applyMessage(state.items, event, threadId) };
    case 'tool.response':
      return {
        ...state,
        items: updateTool(state.items, event.toolCallId ?? '', (row) => {
          const summary = firstLine(event.content);
          const output = responseText(event.content).slice(-65_536);
          const failedCommand = row.name === 'run_command' && /\bexit\s+(?!0\b)(\d+|killed|null)\b/.test(summary);
          return { ...row, status: summary.startsWith('Error') || failedCommand ? 'error' : 'done', summary, output };
        }),
      };
    case 'tool.response_required':
    case 'tool.approval_required':
      return {
        ...state,
        items: asCalls(event.toolCalls).reduce(
          (items, call) => updateTool(items, call.id, (row) => ({ ...row, status: 'waiting' })),
          state.items,
        ),
      };
    case 'thread.created':
      return { ...state, items: [...state.items, { kind: 'thread', id: threadId, title: event.title ?? 'Subagent', status: 'running' }] };
    case 'thread.done':
      return {
        ...state,
        items: state.items.map((row) =>
          row.kind === 'thread' && row.id === threadId
            ? { ...row, status: event.state?.status === 'error' ? 'error' : 'done' }
            : row,
        ),
      };
    default:
      return state;
  }
}

function applyMessage(items: TimelineItem[], event: ForgeEvent, threadId: string): TimelineItem[] {
  let next = items;
  const text = typeof event.content === 'string' ? event.content : '';
  if (text.trim()) next = upsert(next, { kind: 'text', id: event.id, threadId, text });
  for (const call of asCalls(event.toolCalls)) {
    const { name, args } = describeCall(call);
    if (HIDDEN_TOOLS.has(name)) continue;
    const existing = next.find((row) => row.kind === 'tool' && row.id === call.id);
    const status: RowStatus = existing?.kind === 'tool' ? existing.status : 'running';
    next = upsert(next, { kind: 'tool', id: call.id, threadId, name, args, status, ...(existing?.kind === 'tool' && existing.summary ? { summary: existing.summary } : {}) });
  }
  return next;
}

/** Deferred tool loading routes calls through `call_tool`; show the real tool instead. */
export function describeCall(call: ToolCall): { name: string; args: string } {
  const name = call.toolInfo?.name ?? call.function?.name ?? 'tool';
  const args = call.function?.arguments ?? '';
  if (name !== 'call_tool') return { name, args };
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>;
    const inner = [parsed.tool_name, parsed.tool, parsed.name].find((v) => typeof v === 'string');
    const input = parsed.arguments ?? parsed.input ?? parsed.args ?? {};
    if (typeof inner === 'string') return { name: inner, args: typeof input === 'string' ? input : JSON.stringify(input) };
  } catch {
    // arguments still streaming; fall through
  }
  return { name, args };
}

function asCalls(value: unknown): ToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.filter((c): c is ToolCall => typeof c === 'object' && c !== null && typeof (c as ToolCall).id === 'string');
}

function upsert(items: TimelineItem[], item: TimelineItem): TimelineItem[] {
  const index = items.findIndex((row) => row.kind === item.kind && row.id === item.id);
  if (index === -1) return [...items, item];
  const copy = items.slice();
  copy[index] = item;
  return copy;
}

function updateTool(items: TimelineItem[], id: string, change: (row: Extract<TimelineItem, { kind: 'tool' }>) => TimelineItem): TimelineItem[] {
  return items.map((row) => (row.kind === 'tool' && row.id === id ? change(row) : row));
}

/** Every Anvil tool starts its output with a one-line summary; other tools get their first line. */
export function firstLine(content: unknown): string {
  const line = (responseText(content).split('\n').find((l) => l.trim()) ?? '').trim();
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

function responseText(content: unknown): string {
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((part) => (typeof part === 'object' && part && 'text' in part ? String(part.text) : '')).join('')
      : content == null ? '' : JSON.stringify(content);
  return unwrapJsonText(text);
}

/** MCP results sometimes arrive as a JSON-encoded content array. */
function unwrapJsonText(text: string, depth = 0): string {
  if (depth >= 8) return text;
  const trimmed = text.trim();
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return text;
  try {
    const value: unknown = JSON.parse(trimmed);
    if (value && typeof value === 'object' && !Array.isArray(value) && 'error' in value) {
      const error = value.error;
      if (typeof error === 'string') return `Error: ${error}`;
      if (error && typeof error === 'object') {
        if ('message' in error && typeof error.message === 'string') return `Error: ${error.message}`;
        if ('text' in error && typeof error.text === 'string') return unwrapJsonText(error.text, depth + 1);
      }
    }
    const parts = Array.isArray(value) ? value : (value as { content?: unknown }).content;
    if (Array.isArray(parts)) return parts.map((p) => (p && typeof p === 'object' && 'text' in p ? unwrapJsonText(String(p.text), depth + 1) : '')).join('\n');
  } catch {
    // not JSON after all
  }
  return text;
}
