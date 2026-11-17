// M1 live check: a real agent turn reads Flask through Anvil's MCP tools and streams an answer.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startLive, type Live } from './harness';

let live: Live;
beforeAll(async () => { live = await startLive(); });
afterAll(() => live.close());

describe('live chat turn', () => {
  it('uses the read tools on the Flask repo and answers', async () => {
    await live.controller.send('Open src/flask/helpers.py and tell me, in one sentence, which environment variable get_debug_flag reads.');
    const state = live.last();
    const tools = state.items.filter((i) => i.kind === 'tool');
    const text = state.items.filter((i) => i.kind === 'text').map((i) => (i.kind === 'text' ? i.text : '')).join(' ');
    console.log(JSON.stringify(state.items, null, 1).slice(0, 2000));
    expect(state.running).toBe(false);
    expect(tools.some((t) => t.kind === 'tool' && t.status === 'done')).toBe(true);
    expect(text).toMatch(/FLASK_DEBUG/);
  });

  it('stops mid-stream and reports it', async () => {
    live.controller.newChat();
    const run = live.controller.send('Read src/flask/app.py fully, page by page, and then summarise every method in detail.');
    await new Promise((r) => setTimeout(r, 2500));
    live.controller.stop();
    await run;
    expect(live.last().items.at(-1)).toMatchObject({ kind: 'notice', title: 'Stopped' });
  });
});
