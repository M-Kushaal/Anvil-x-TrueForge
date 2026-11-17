// Shared setup for live tests: real TrueForge, real model, Anvil's MCP server on the Flask checkout.
import { flaskRoot } from '../support/paths';
import { ForgeClient, type ApprovalRequest, type Decision } from '../../src/forge/client';
import { registerConnector } from '../../src/forge/connector';
import { startMcpServer, type McpHost } from '../../src/mcp/server';
import { readTools } from '../../src/mcp/readTools';
import { createWorkspace, type Workspace } from '../../src/workspace/workspace';
import { ChatController } from '../../src/chat/controller';
import type { ChatState } from '../../src/shared/protocol';
import type { Tool } from '../../src/mcp/tool';

export const SERVER = process.env.TRUEFORGE_URL ?? 'http://localhost:8790';
export const MODEL = process.env.ANVIL_MODEL ?? 'groq/gpt-oss-120b';
export const FLASK = flaskRoot;

export interface Live {
  workspace: Workspace;
  host: McpHost;
  controller: ChatController;
  client: ForgeClient;
  last(): ChatState;
  close(): Promise<void>;
}

export async function startLive({ tools, onApproval, models = [MODEL] }: {
  tools?: (ws: Workspace) => Tool[];
  onApproval?: (r: ApprovalRequest) => Promise<Decision>;
  models?: string[];
} = {}): Promise<Live> {
  const workspace = createWorkspace({ root: FLASK });
  const host = await startMcpServer({ tools: () => (tools ?? readTools)(workspace) });
  const { client, sdk } = ForgeClient.connect(SERVER);
  await registerConnector(sdk, host);
  let state: ChatState | undefined;
  const controller = new ChatController({
    client,
    models: () => models,
    post: (s) => { state = s; },
    onApproval: onApproval ?? (async () => ({ status: 'deny', reason: 'test' })),
    ensureReady: async () => undefined,
  });
  return { workspace, host, controller, client, last: () => state!, close: () => host.close() };
}
