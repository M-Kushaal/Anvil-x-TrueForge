// `npm run forge`: starts TrueForge (local mode) and the model relays together: Groq on :8791,
// Cerebras on :8792 (both strip the replayed reasoning those endpoints reject).
// TrueForge is pinned to the version Anvil was built and tested against (0.185.0); @latest can change
// event and approval shapes the extension relies on.
// Loopback is allow-listed so TrueForge can reach Anvil's MCP server, the relay and Ollama;
// the SSRF guard stays on for every other private address.
import { spawn } from 'node:child_process';

const env = { ...process.env, OUTBOUND_URL_ALLOWED_HOSTS: '["127.0.0.1"]' };
const shell = process.platform === 'win32';

const children = [
  spawn('node', ['scripts/model-relay.ts'], { stdio: 'inherit', env }),
  spawn('node', ['scripts/model-relay.ts'], { stdio: 'inherit', env: { ...env, UPSTREAM: 'https://api.cerebras.ai/v1', RELAY_PORT: '8792' } }),
  spawn('npx', ['-y', '@truefoundry/trueforge@0.185.0'], { stdio: 'inherit', env, shell }),
];

// Load the local fallback model now so a fallback never waits on a cold start.
setTimeout(() => {
  fetch('http://127.0.0.1:11434/api/tags').then((r) => r.json()).then(({ models = [] }) => {
    const model = models.map((m) => m.name).find((n) => n.startsWith('qwen2.5:'));
    if (model) return fetch('http://127.0.0.1:11434/api/generate', { method: 'POST', body: JSON.stringify({ model, prompt: '', keep_alive: '60m' }) });
  }).catch(() => undefined);
}, 3000);

const stop = () => { for (const child of children) child.kill(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
