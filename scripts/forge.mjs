// `npm run forge`: starts TrueForge (local mode) and the model relays together: Groq on :8791,
// Cerebras on :8792 (both strip the replayed reasoning those endpoints reject).
// TrueForge is pinned to the version Anvil was built and tested against (0.185.0); @latest can change
// event and approval shapes the extension relies on.
// Loopback is allow-listed so TrueForge can reach Anvil's MCP server, the relay and Ollama;
// the SSRF guard stays on for every other private address.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

const envFile = new URL('../.env', import.meta.url);
const local = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {};
const relayPort = (name, fallback) => process.env[name] || local[name] || fallback;
const env = { ...process.env, OUTBOUND_URL_ALLOWED_HOSTS: '["127.0.0.1"]' };
const shell = process.platform === 'win32';

const children = [
  spawn('node', ['scripts/model-relay.ts'], { stdio: 'inherit', env: { ...env, RELAY_PORT: relayPort('RELAY_PORT', '8791') } }),
  spawn('node', ['scripts/model-relay.ts'], { stdio: 'inherit', env: { ...env, UPSTREAM: 'https://api.cerebras.ai/v1', RELAY_PORT: relayPort('CEREBRAS_RELAY_PORT', '8792') } }),
  spawn('npx', ['-y', '@truefoundry/trueforge@0.185.0'], { stdio: 'inherit', env, shell }),
];

// Load the local fallback model now so a fallback never waits on a cold start.
setTimeout(() => {
  fetch('http://127.0.0.1:11434/api/tags').then((r) => r.json()).then(({ models = [] }) => {
    const model = models.map((m) => m.name).find((n) => n.startsWith('qwen2.5:'));
    if (model) return fetch('http://127.0.0.1:11434/api/generate', { method: 'POST', body: JSON.stringify({ model, prompt: '', keep_alive: '60m' }) });
  }).catch(() => undefined);
}, 3000);

let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  process.exitCode = code;
}
for (const [index, child] of children.entries()) {
  const name = ['Groq relay', 'Cerebras relay', 'TrueForge'][index];
  child.on('error', (error) => {
    if (!stopping) console.error(`${name} failed: ${error.message}`);
    if (index !== 1) stop(1);
  });
  child.on('exit', (code, signal) => {
    if (!stopping) console.error(`${name} exited unexpectedly (${signal ?? code}).`);
    if (index !== 1) stop(1);
  });
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
