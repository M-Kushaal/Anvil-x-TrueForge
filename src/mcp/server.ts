// Streamable-HTTP MCP server exposing the editor's tools to TrueForge.
// Loopback only, random port, bearer token; stateless (a fresh transport per request).
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Tool } from './tool';

export interface McpHost {
  url: string;
  token: string;
  close(): Promise<void>;
}

export async function startMcpServer({ tools, port = 0 }: { tools: () => Tool[]; port?: number }): Promise<McpHost> {
  const token = randomBytes(24).toString('hex');

  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) return void res.writeHead(401).end();
    // The optional server→client SSE stream is not offered (allowed by the MCP spec).
    if (req.method !== 'POST') return void res.writeHead(405, { allow: 'POST' }).end();
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString() || 'null');
      const mcp = buildServer(tools());
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => void transport.close().then(() => mcp.close()));
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      if (!res.headersSent) res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: String(error) }, id: null }));
    }
  });

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  return {
    url: `http://127.0.0.1:${actualPort}/mcp`,
    token,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function buildServer(tools: Tool[]): McpServer {
  const mcp = new McpServer({ name: 'anvil-editor', version: '0.1.0' });
  for (const tool of tools) {
    mcp.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.input, annotations: tool.annotations },
      async (args: unknown) => ({ content: [{ type: 'text' as const, text: await tool.run(args) }] }),
    );
  }
  return mcp;
}
