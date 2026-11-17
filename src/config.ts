// The `anvil.*` settings, read fresh on every use so changes apply without a reload.
// Defaults mirror package.json (VS Code supplies those; these cover a missing contribution).
import * as vscode from 'vscode';

export interface AnvilConfig {
  allowModelFallback: boolean;
  serverUrl: string;
  /** Model chain: the first is primary, the rest are automatic fallbacks. */
  models: string[];
  contextBudget: number;
  graphifyCommand: string;
  commandPath: string[];
  /** Input tokens at which TrueForge compacts older history. */
  compactAt: number;
  /** Providers with small per-request limits (lean spec, smaller pack, earlier compaction). */
  leanProviders: string[];
}

export function readConfig(): AnvilConfig {
  const c = vscode.workspace.getConfiguration('anvil');
  return {
    allowModelFallback: c.get('allowModelFallback', true),
    serverUrl: c.get('serverUrl', 'http://localhost:8790'),
    models: c.get<string[]>('models', ['groq/gpt-oss-120b', 'groq-2/gpt-oss-120b', 'groq/gpt-oss-20b', 'groq-2/gpt-oss-20b', 'ollama/qwen2-5-3b']),
    contextBudget: c.get('contextBudget', 3000),
    graphifyCommand: c.get('graphifyCommand', 'graphify'),
    commandPath: c.get<string[]>('commandPath', []),
    compactAt: c.get('compactAt', 60000),
    leanProviders: c.get<string[]>('leanProviders', ['groq']),
  };
}
