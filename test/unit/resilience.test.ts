import { describe, expect, it } from 'vitest';
import { twinOf, classify, describeStep, nextStep } from '../../src/forge/resilience';

const chain = ['groq/gpt-oss-120b', 'groq/gpt-oss-20b', 'ollama/qwen2.5-coder-3b'];

describe('classify (real TrueForge messages)', () => {
  it.each([
    ['[Model Error] Request failed (401): Invalid API Key', 'auth', '401 invalid API key'],
    ['[Model Error] Request failed (404): The model `x` does not exist or you do not have access to it.', 'not_found', '404 model not found'],
    ['[Model Error] Cannot connect to API: bad port', 'network', 'endpoint unreachable'],
    ['[Model Error] Request failed (503): Service Unavailable', 'server', '503 server error'],
    ['fetch failed', 'network', 'endpoint unreachable'],
    ['Request timed out', 'timeout', 'request timed out'],
  ])('%s → %s', (message, kind, summary) => {
    expect(classify(message)).toMatchObject({ kind, summary });
  });

  it('treats an oversized request as unrecoverable on that model', () => {
    const e = classify('[Model Error] Request failed (413): Request too large for model `openai/gpt-oss-120b` on tokens per minute (TPM): Limit 8000, Requested 9512');
    expect(e.kind).toBe('too_large');
    expect(nextStep({ chain, index: 0, retries: 0, error: e })).toEqual({ action: 'switch', to: 1 });
  });

  it('reads the retry-after of a Groq rate limit', () => {
    const e = classify('[Model Error] Request failed (429): Rate limit reached for model `openai/gpt-oss-120b` ... Please try again in 25.86s. Need more tokens?');
    expect(e).toEqual({ kind: 'rate_limit', summary: '429 rate limited', retryAfterMs: 25_860 });
    expect(classify('Rate limit reached. Please try again in 750ms.').retryAfterMs).toBe(750);
    expect(classify('(429) Rate limit reached ... Please try again in 1m2.5s.').retryAfterMs).toBe(62_500);
    expect(classify('(429) tokens per day ... Please try again in 7m').retryAfterMs).toBe(420_000);
    expect(classify('(429) RESOURCE_EXHAUSTED. Please retry in 41.277s.').retryAfterMs).toBe(41_277);
    expect(classify('(429) quota exceeded "retryDelay": "17s"').retryAfterMs).toBe(17_000);
  });
});

describe('nextStep', () => {
  it('waits out a short rate limit, then moves on', () => {
    const error = classify('Request failed (429): Please try again in 25.86s');
    expect(nextStep({ chain, index: 0, retries: 0, error })).toEqual({ action: 'retry', delayMs: 26_360 });
    expect(nextStep({ chain, index: 0, retries: 5, error })).toEqual({ action: 'retry', delayMs: 26_360 });
    expect(nextStep({ chain, index: 0, retries: 6, error })).toEqual({ action: 'switch', to: 1 });
  });

  it('uses whichever of two accounts serving the same model is free first', () => {
    const keys = ['groq/gpt-oss-120b', 'groq-2/gpt-oss-120b', 'ollama/qwen2-5-3b'];
    const error = classify('Request failed (429): Please try again in 9.5s');
    // Twin untried: hop at once.
    expect(nextStep({ chain: keys, index: 0, retries: 0, error })).toEqual({ action: 'switch', to: 1, delayMs: 0 });
    // Twin free in 3s: wait for it rather than 9.5s here.
    expect(nextStep({ chain: keys, index: 1, retries: 1, error, cooldowns: { 0: 3000 } })).toEqual({ action: 'switch', to: 0, delayMs: 3500 });
    // Twin out for the day (tokens per day): stay and wait out this model's short limit.
    const short = classify('(429) tokens per minute ... Please try again in 1.89s');
    expect(nextStep({ chain: keys, index: 1, retries: 1, error: short, cooldowns: { 0: 23 * 60_000 } })).toEqual({ action: 'retry', delayMs: 2390 });
    expect(nextStep({ chain: keys, index: 1, retries: 12, error })).toEqual({ action: 'switch', to: 2 });
    expect(twinOf(keys, 2)).toBeUndefined();
  });

  it('gives up at once when the editor tools are unreachable, without blaming the model', () => {
    const error = classify("[MCP Error] Failed to connect to remote MCP server 'anvil-editor': failed to connect");
    const step = nextStep({ chain, index: 0, retries: 0, error });
    expect(step).toEqual({ action: 'give_up' });
    expect(describeStep({ chain, index: 0, error, step }).title).toBe('Editor tools unreachable');
  });

  it('retries a malformed tool call at once, on the same model', () => {
    const error = classify('Tool call validation failed: parameters for tool call_tool did not match schema');
    expect(error.kind).toBe('bad_tool_call');
    expect(nextStep({ chain, index: 0, retries: 0, error })).toEqual({ action: 'retry', delayMs: 0 });
    expect(nextStep({ chain, index: 0, retries: 2, error })).toEqual({ action: 'switch', to: 1 });
    expect(classify('[Model Error] Failed to parse tool call arguments as JSON').kind).toBe('bad_tool_call');
  });

  it('switches at once when the wait is too long', () => {
    expect(nextStep({ chain, index: 0, retries: 0, error: classify('(429) try again in 90s') })).toEqual({ action: 'switch', to: 1 });
  });

  it('backs off on network errors before switching', () => {
    const error = classify('Cannot connect to API');
    expect(nextStep({ chain, index: 0, retries: 0, error })).toEqual({ action: 'retry', delayMs: 1000 });
    expect(nextStep({ chain, index: 0, retries: 1, error })).toEqual({ action: 'retry', delayMs: 3000 });
    expect(nextStep({ chain, index: 0, retries: 2, error })).toEqual({ action: 'switch', to: 1 });
  });

  it('skips every model on the same provider after a rejected key', () => {
    expect(nextStep({ chain, index: 0, retries: 0, error: classify('(401) Invalid API Key') })).toEqual({ action: 'switch', to: 2 });
  });

  it('tries the next model of the same provider when only one model is missing', () => {
    expect(nextStep({ chain, index: 0, retries: 0, error: classify('(404) does not exist') })).toEqual({ action: 'switch', to: 1 });
  });

  it('gives up at the end of the chain', () => {
    expect(nextStep({ chain, index: 2, retries: 0, error: classify('(401) Invalid API Key') })).toEqual({ action: 'give_up' });
  });
});

describe('describeStep', () => {
  it('says what happened and what Anvil did', () => {
    const error = classify('(401) Invalid API Key');
    expect(describeStep({ chain, index: 0, error, step: { action: 'switch', to: 2 } })).toEqual({
      level: 'warn',
      title: 'Switched model',
      detail: 'groq/gpt-oss-120b: 401 invalid API key. Continuing on ollama/qwen2.5-coder-3b.',
    });
    expect(describeStep({ chain, index: 2, error, step: { action: 'give_up' } }).title).toBe('No model reachable');
  });
});
