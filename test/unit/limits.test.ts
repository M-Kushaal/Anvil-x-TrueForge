import { describe, expect, it } from 'vitest';
import { buildSpec } from '../../src/forge/agentSpec';
import { limitsFor } from '../../src/models/limits';

const settings = { leanProviders: ['groq'], compactAt: 60000, contextBudget: 3000 };

describe('limitsFor', () => {
  it('shrinks the pack and compacts early on small-limit providers and their suffixed variants', () => {
    for (const model of ['groq/gpt-oss-120b', 'groq-2/gpt-oss-120b', 'groq-backup/gpt-oss-20b']) {
      expect(limitsFor(model, settings)).toEqual({ lean: true, compactAt: 6000, contextBudget: 1800 });
    }
  });

  it('leaves other providers alone', () => {
    expect(limitsFor('ollama/qwen2-5-3b', settings)).toEqual({ lean: false, compactAt: 60000, contextBudget: 3000 });
    expect(limitsFor('groqish/x', settings).lean).toBe(false);
  });
});

describe('buildSpec lean', () => {
  const server = (spec: Record<string, unknown>) => (spec.mcpServers as Array<Record<string, unknown>>)[0]!;
  const config = (spec: Record<string, unknown>) => spec.config as Record<string, { enabled?: boolean }>;

  it('turns off subagents and ask-user, and preloads every tool', () => {
    const spec = buildSpec({ model: 'groq/gpt-oss-120b', lean: true });
    expect(config(spec).dynamicSubAgents?.enabled).toBe(false);
    expect(config(spec).askUserQuestions?.enabled).toBe(false);
    expect(server(spec).preload).toBe(true);
    expect(server(spec).preloadTools).toBeUndefined();
    expect((spec.model as { params?: object }).params).toEqual({ maxTokens: 1536, reasoningEffort: 'low' });
    expect(spec.instructions).toMatch(/context window is small/);
  });

  it('keeps deferred loading and subagents otherwise', () => {
    const spec = buildSpec({ model: 'ollama/qwen2-5-3b' });
    expect(config(spec).dynamicSubAgents?.enabled).toBe(true);
    expect(server(spec).preloadTools).toContain('propose_edit');
    expect(server(spec).preload).toBeUndefined();
  });
});

describe('buildSpec connector', () => {
  it('points the MCP server at this window\'s connector', () => {
    const spec = buildSpec({ model: 'm', connector: 'anvil-editor-abc' });
    expect((spec.mcpServers as Array<{ name: string }>)[0]!.name).toBe('anvil-editor-abc');
    expect((buildSpec({ model: 'm' }).mcpServers as Array<{ name: string }>)[0]!.name).toBe('anvil-editor');
  });
});
