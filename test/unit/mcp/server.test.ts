// Contract test: a real MCP client talks to the server over HTTP.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startMcpServer, type McpHost } from '../../../src/mcp/server';
import { readTools } from '../../../src/mcp/readTools';
import { createWorkspace } from '../../../src/workspace/workspace';
import { fixturePath } from '../../support/paths';

const ws = createWorkspace({ root: fixturePath('mini-repo') });
let host: McpHost;

beforeAll(async () => {
  host = await startMcpServer({ tools: () => readTools(ws) });
});
afterAll(() => host.close());

async function connect(token = host.token): Promise<Client> {
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(host.url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  return client;
}

describe('MCP server', () => {
  it('binds to loopback', () => {
    expect(host.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  });

  it('lists tools with read-only annotations', async () => {
    const { tools } = await (await connect()).listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['list_dir', 'read_file', 'search_code']);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
  });

  it('runs a tool call end to end', async () => {
    const result = await (await connect()).callTool({ name: 'read_file', arguments: { path: 'src/app/cli.py', start: 4, end: 5 } });
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text.split('\n')).toEqual(['src/app/cli.py · lines 4–5 of 20', '4│@click.command("routes")', '5│def routes_command():', '… 15 more lines. Call read_file with start=6 to continue.']);
  });

  it('rejects requests without the bearer token', async () => {
    await expect(connect('wrong')).rejects.toThrow();
  });

  it('declines GET (no server-initiated stream)', async () => {
    const res = await fetch(host.url, { headers: { Authorization: `Bearer ${host.token}` } });
    expect(res.status).toBe(405);
  });
});
