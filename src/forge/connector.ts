// Registers an extension host's MCP server with TrueForge.
import type { TrueForge } from '@truefoundry/trueforge-sdk';
import { CONNECTOR_NAME } from './client';
import type { McpHost } from '../mcp/server';

export async function registerConnector(sdk: TrueForge, host: McpHost, name = CONNECTOR_NAME, serverUrl = 'TrueForge'): Promise<void> {
  try {
    await sdk.settings.mcpServers.createOrUpdate({
      manifest: {
        name,
        type: 'remote',
        url: host.url,
        description: 'Editor tools for the open VS Code workspace: read, search, outline, propose edits, run commands.',
        auth: { type: 'header', headers: { Authorization: `Bearer ${host.token}` } },
      },
    }, { timeoutInSeconds: 10 });
  } catch (error) {
    throw new Error(explain(error, serverUrl), { cause: error });
  }
}

function explain(error: unknown, serverUrl: string): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/Outbound URL blocked/.test(text)) {
    return 'TrueForge refused Anvil\'s local tools. Start TrueForge with OUTBOUND_URL_ALLOWED_HOSTS=["127.0.0.1"] (see the README), then Retry.';
  }
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|timed? ?out/i.test(text)) {
    return `Can't reach TrueForge at ${serverUrl}. Start TrueForge, or change anvil.serverUrl, then Retry.`;
  }
  return `Couldn't connect Anvil's tools to TrueForge: ${text}`;
}
