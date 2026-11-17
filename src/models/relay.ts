// Pure core of the model relay (scripts/model-relay.ts).
// TrueForge replays a reasoning model's chain-of-thought as `reasoning_content` on assistant
// messages; Groq's OpenAI-compatible endpoint rejects that field, so the relay removes it.

type ChatBody = { messages?: Array<Record<string, unknown>> } & Record<string, unknown>;

/** Returns a copy of a chat-completions body without replayed reasoning. */
export function stripReplayedReasoning(body: ChatBody): ChatBody {
  if (!Array.isArray(body.messages)) return body;
  return {
    ...body,
    messages: body.messages.map(({ reasoning_content: _dropped, ...message }) => message),
  };
}

/** Maps a relay request path (`/v1/chat/completions`) onto the upstream base URL. */
export function upstreamUrl({ base, path }: { base: string; path: string }): string {
  return base.replace(/\/+$/, '') + path.replace(/^\/v1(?=\/|$)/, '');
}

/** One line describing where a request's tokens go (≈4 characters per token). */
export function requestSizes(body: ChatBody): string {
  const tokens = (v: unknown) => Math.round(JSON.stringify(v ?? '').length / 4);
  const messages = body.messages ?? [];
  const system = messages.filter((m) => m.role === 'system');
  const tools = Array.isArray(body.tools) ? body.tools : [];
  return `${body.model} · system ~${tokens(system)} · tools ${tools.length} ~${tokens(tools)} · messages ${messages.length - system.length} ~${tokens(messages.filter((m) => m.role !== 'system'))} · max_tokens ${body.max_tokens ?? body.max_completion_tokens ?? '-'}`;
}
