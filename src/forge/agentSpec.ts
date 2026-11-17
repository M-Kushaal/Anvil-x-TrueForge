// Builds the inline TrueForge agent spec from agents/anvil.json (snake_case, as in TrueForge's
// docs) for a given model. The SDK expects camelCase keys.
import definition from '../../agents/anvil.json';

export interface SpecOptions {
  model: string;
  /** Replaces the default instructions (used by inline edit). */
  instructions?: string;
  /** Overrides which tools the session may use. */
  enableTools?: string[];
  /** Shallow overrides of `config` (snake_case keys, as in agents/anvil.json). */
  config?: Record<string, unknown>;
  /** Small per-request limits (Groq's free tier: 8k tokens, output included); see LEAN. */
  lean?: boolean;
  /** The MCP connector to use (one per VS Code window); defaults to the one in agents/anvil.json. */
  connector?: string;
}

/**
 * Lean mode: no subagents or ask-user prompts (less harness prompt), every tool preloaded (no step
 * spent rediscovering tools after a compaction), short output and reasoning, and instructions that
 * work from the context pack instead of reading files.
 */
const LEAN = {
  config: { dynamic_sub_agents: { enabled: false }, ask_user_questions: { enabled: false } },
  params: { max_tokens: 1536, reasoning_effort: 'low' },
  instructions: [
    "You are Anvil, a coding agent in the user's VS Code workspace (anvil-editor tools). Your context window is small, so every read counts.",
    '1. The context pack in the request has the exact, line-numbered lines you need: the pattern to copy, where it is registered, the matching test and docs. Edit straight from it.',
    '2. propose_edit: copy `search` verbatim from the pack or a read (without line numbers); to insert, include an anchor line in `search` and repeat it in `replace`. One call per place. If denied, fix the call from the reason.',
    '3. Read a file only when the lines you need are not in the pack, at most 40 lines at a time.',
    '4. Call update_plan once with short steps, then mark each done as you go. Change code, test and docs as the task asks, following the nearest existing pattern.',
    '5. Finish with 2-3 short lines: what changed and where.',
  ].join('\n'),
};

export function buildSpec({ model, instructions, enableTools, config, lean, connector }: SpecOptions): Record<string, unknown> {
  const { name: _name, description: _description, ...manifest } = definition;
  const tools = (preload_tools: string[]) =>
    enableTools ? { enable_tools: enableTools, preload_tools: enableTools } : lean ? { preload: true } : { preload_tools };
  const spec = {
    ...manifest,
    model: { ...manifest.model, name: model, ...(lean ? { params: LEAN.params } : {}) },
    instructions: instructions ?? (lean ? LEAN.instructions : manifest.instructions),
    config: { ...manifest.config, ...(lean ? LEAN.config : {}), ...config },
    mcp_servers: manifest.mcp_servers.map(({ preload_tools, ...server }) => ({ ...server, name: connector ?? server.name, ...tools(preload_tools) })),
  };
  return camelKeys(spec) as Record<string, unknown>;
}

/** Deep snake_case → camelCase for object keys; values (tool names etc.) are left alone. */
function camelKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, v]) => [key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), camelKeys(v)]),
  );
}
