// `npm run setup`: registers Anvil's models and agent in a running TrueForge (local mode).
//   - groq:   OpenAI-compatible, through the local model relay (scripts/model-relay.ts)
//   - ollama: local fallback (http://127.0.0.1:11434/v1), if Ollama is running
//   - agent:  agents/anvil.json saved as the "anvil" agent (visible in TrueForge's Agents page)
// Keys: GROQ_API_KEY (optionally GROQ_BACKUP_API_KEY, GROQ_SECOND_KEY) ANTHROPIC_API_KEY and CEREBRAS_API_KEY, from the environment or .env;
// a key already stored in TrueForge is kept as is.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { TrueForge } from '@truefoundry/trueforge-sdk';

const root = path.resolve(import.meta.dirname, '..');
loadDotEnv(path.join(root, '.env'));
const BASE = process.env.TRUEFORGE_URL ?? 'http://localhost:8790';
const RELAY = `http://127.0.0.1:${process.env.RELAY_PORT ?? 8791}/v1`;
const client = new TrueForge({ baseUrl: BASE });

// Groq's free tier counts max_tokens against 8k tokens per minute and per request; with ~3k of fixed
// prompt, 2k of output leaves room for history. Edits come in small chunks, so 2k is enough.
const props = { contextLength: 131072, maxOutputTokens: 2048, reasoningEfforts: ['low', 'medium', 'high'] };
const { data: providers } = await client.settings.modelProviders.list();
const existing = (name) => providers.find((p) => (p.manifest ?? p).name === name);

// Groq through the relay, one provider per key. Keys from different Groq accounts have separate
// quotas: Anvil hops between the same model on two providers when one is rate limited. Keys from the
// same account share one quota (8k tokens/minute on the free tier), so they only help as a fallback.
const GROQ_KEYS = [['groq', 'GROQ_API_KEY'], ['groq-backup', 'GROQ_BACKUP_API_KEY'], ['groq-2', 'GROQ_SECOND_KEY']];
const keyOf = (name) => existing(name) && (existing(name).manifest ?? existing(name)).auth?.apiKey;
const groqModels = [
  { modelId: 'openai/gpt-oss-120b', name: 'gpt-oss-120b', properties: props },
  { modelId: 'openai/gpt-oss-20b', name: 'gpt-oss-20b', properties: props },
];
for (const [name, env] of GROQ_KEYS) {
  // The redacted key TrueForge returns for an existing provider keeps the stored one.
  const apiKey = process.env[env] || keyOf(name);
  if (!apiKey) {
    console.log(`· ${name} skipped: set ${env} in anvil/.env (git-ignored), or add the provider in TrueForge Settings → Models`);
    continue;
  }
  await client.settings.modelProviders.createOrUpdate({ manifest: { type: 'custom', name, baseUrl: RELAY, auth: { apiKey }, models: groqModels } });
  console.log(`✓ ${name}: gpt-oss-120b, gpt-oss-20b (via relay)`);
}

// Cerebras (OpenAI-compatible): gpt-oss-120b, the same model on a separate account with its own quota.
// Through a relay on :8792 (`UPSTREAM=https://api.cerebras.ai/v1 RELAY_PORT=8792 node scripts/model-relay.ts`):
// it strips the replayed reasoning that Cerebras rejects on the second call of a turn.
const CEREBRAS_RELAY = `http://127.0.0.1:${process.env.CEREBRAS_RELAY_PORT ?? 8792}/v1`;
const cerebrasKey = process.env.CEREBRAS_API_KEY || keyOf('cerebras');
if (cerebrasKey) {
  await client.settings.modelProviders.createOrUpdate({ manifest: {
    type: 'custom', name: 'cerebras', baseUrl: CEREBRAS_RELAY, auth: { apiKey: cerebrasKey },
    models: [{ modelId: 'gpt-oss-120b', name: 'gpt-oss-120b', properties: { contextLength: 131072, maxOutputTokens: 8192 } }],
  } });
  console.log('✓ cerebras: gpt-oss-120b');
} else {
  console.log('· cerebras skipped: set CEREBRAS_API_KEY in anvil/.env (git-ignored)');
}

// Anthropic, if a key is set: the cheapest current Claude model (Haiku 5.5), used for Task B.
const anthropicKey = process.env.ANTHROPIC_API_KEY || keyOf('anthropic');
if (anthropicKey) {
  await client.settings.modelProviders.createOrUpdate({ manifest: {
    type: 'anthropic', name: 'anthropic', auth: { apiKey: anthropicKey },
    models: [{ modelId: 'claude-haiku-5-5', name: 'claude-haiku-5-5', properties: { contextLength: 200000, maxOutputTokens: 8192 } }],
  } });
  console.log('✓ anthropic: claude-haiku-5-5');
} else {
  console.log('· anthropic skipped: set ANTHROPIC_API_KEY in anvil/.env (git-ignored)');
}

// Ollama, if it answers.
const ollama = await fetch('http://127.0.0.1:11434/api/tags').then((r) => r.json()).catch(() => undefined);
// Prefer models whose Ollama template supports native tool calls (qwen2.5-coder's does not).
const installed = ollama?.models?.map((m) => m.name) ?? [];
const local = ['qwen2.5:3b', 'qwen2.5:7b', 'llama3.2:3b', 'qwen2.5', 'llama3.2'].map((p) => installed.find((n) => n.startsWith(p))).find(Boolean) ?? installed[0];
if (local) {
  await client.settings.modelProviders.createOrUpdate({ manifest: {
    type: 'custom', name: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', auth: { apiKey: 'ollama' },
    models: [{ modelId: local, name: local.toLowerCase().replace(/[^a-z0-9-]+/g, '-'), properties: { contextLength: 32768, maxOutputTokens: 4096 } }],
  } });
  console.log(`✓ ollama: ${local}`);
} else {
  console.log('· ollama skipped: not running (optional local fallback: ollama pull qwen2.5:3b)');
}

// The agent definition, saved by name so it is browsable in TrueForge.
const spec = JSON.parse(readFileSync(path.join(root, 'agents/anvil.json'), 'utf8'));
const { name, description, ...manifest } = spec;
const agents = [];
for await (const a of await client.agents.list()) agents.push(a);
const found = agents.find((a) => a.name === name);
const camel = (v) => Array.isArray(v) ? v.map(camel) : v && typeof v === 'object'
  ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), camel(x)])) : v;
if (found) await client.agents.update(found.id, { manifest: camel(manifest) });
else await client.agents.create({ name, description, manifest: camel(manifest) });
console.log(`✓ agent "${name}" saved`);

const { data: models } = await client.models.list();
console.log(`Models available: ${models.map((m) => m.name).join(', ')}`);

function loadDotEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}
