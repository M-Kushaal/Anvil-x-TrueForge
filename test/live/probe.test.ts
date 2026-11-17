// Which models answer right now: one tiny turn each.
// ANVIL_MODELS=a,b npm run test:live -- test/live/probe.test.ts
import { it } from 'vitest';
import { buildSpec } from '../../src/forge/agentSpec';
import { ForgeClient } from '../../src/forge/client';
import { SERVER } from './harness';

const MODELS = (process.env.ANVIL_MODELS ?? '').split(',').filter(Boolean);

it.skipIf(!MODELS.length)('probes models', async () => {
  const { client } = ForgeClient.connect(SERVER);
  for (const model of MODELS) {
    const t0 = Date.now();
    const sessionId = await client.createSession({ ...buildSpec({ model, instructions: 'Reply with one word.' }), mcpServers: [] }); // model only, no editor
    const outcome = await client.runTurn({
      sessionId,
      input: [{ type: 'user.message', content: 'Say OK.' }],
      handlers: { onEvent: () => undefined, onApproval: async () => ({ status: 'deny', reason: 'no tools' }) },
    });
    const message = 'message' in outcome ? String(outcome.message).slice(0, 160) : '';
    console.log(`${model.padEnd(40)} ${outcome.status.padEnd(9)} ${Date.now() - t0}ms ${message}`);
  }
}, 300_000);
