import { describe, expect, it } from 'vitest';
import { stripReplayedReasoning, upstreamUrl } from '../../src/models/relay';

describe('stripReplayedReasoning', () => {
  it('removes reasoning_content from every message and keeps everything else', () => {
    const body = {
      model: 'openai/gpt-oss-120b',
      stream: true,
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '', reasoning_content: 'thinking…', tool_calls: [{ id: 't1' }] },
      ],
    };
    expect(stripReplayedReasoning(body)).toEqual({
      model: 'openai/gpt-oss-120b',
      stream: true,
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '', tool_calls: [{ id: 't1' }] },
      ],
    });
  });

  it('does not mutate the input', () => {
    const body = { messages: [{ role: 'assistant', reasoning_content: 'x' }] };
    stripReplayedReasoning(body);
    expect(body.messages[0]).toHaveProperty('reasoning_content', 'x');
  });

  it('passes through bodies without messages', () => {
    const body = { input: 'embed me' };
    expect(stripReplayedReasoning(body)).toBe(body);
  });
});

describe('upstreamUrl', () => {
  it('maps /v1 paths onto the upstream base', () => {
    expect(upstreamUrl({ base: 'https://api.groq.com/openai/v1', path: '/v1/chat/completions' }))
      .toBe('https://api.groq.com/openai/v1/chat/completions');
  });

  it('tolerates a trailing slash on the base and paths without /v1', () => {
    expect(upstreamUrl({ base: 'https://x.dev/v1/', path: '/models' })).toBe('https://x.dev/v1/models');
  });

  it('does not strip /v1 from longer segments', () => {
    expect(upstreamUrl({ base: 'https://x.dev', path: '/v1beta/models' })).toBe('https://x.dev/v1beta/models');
  });
});
