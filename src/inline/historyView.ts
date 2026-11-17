// "Anvil: Inline Edit History": a list of every inline edit in this workspace, newest first.
// Picking an edit opens its file at the edited lines; the first row opens the shared TrueForge session.
import * as vscode from 'vscode';
import path from 'node:path';
import type { ForgeClient } from '../forge/client';
import type { InlineEntry, InlineHistory, InlineStatus } from './history';

const ICON: Record<InlineStatus, string> = {
  running: '$(sync~spin)',
  staged: '$(diff)',
  'no-change': '$(circle-slash)',
  failed: '$(error)',
  stopped: '$(debug-stop)',
};

const WORDS: Record<InlineStatus, string> = {
  running: 'running',
  staged: 'pending review',
  'no-change': 'no change proposed',
  failed: 'failed',
  stopped: 'stopped',
};

export async function showInlineHistory(history: InlineHistory, client: ForgeClient, root: string): Promise<void> {
  const session = history.session();
  const entries = history.entries();
  const items: Array<vscode.QuickPickItem & { entry?: InlineEntry; url?: string }> = [];
  if (session) items.push({ label: '$(link-external) Open the shared TrueForge session', description: 'every inline edit, as turns', url: client.sessionUrl(session) });
  if (entries.length === 0) items.push({ label: 'No inline edits yet', description: 'Select code and press Ctrl+I' });
  for (const entry of entries) {
    items.push({
      label: `${ICON[entry.status]} ${entry.path}:${entry.startLine}-${entry.endLine}`,
      description: `${WORDS[entry.status]} · ${new Date(entry.at).toLocaleString()}`,
      detail: entry.instruction + (entry.detail ? `  —  ${entry.detail}` : ''),
      entry,
    });
  }
  const picked = await vscode.window.showQuickPick(items, { title: 'Anvil · Inline Edit History', matchOnDetail: true });
  if (!picked) return;
  if (picked.url) return void vscode.env.openExternal(vscode.Uri.parse(picked.url));
  if (picked.entry) {
    const line = Math.max(0, picked.entry.startLine - 1);
    const file = path.join(root, ...picked.entry.path.split('/'));
    await vscode.window.showTextDocument(vscode.Uri.file(file), { selection: new vscode.Range(line, 0, line, 0), preview: true });
  }
}
