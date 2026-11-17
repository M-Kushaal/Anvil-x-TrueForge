// "Anvil: History": earlier chats in this workspace, newest first, then the inline-edit history.
// Picking a chat reopens it; new messages continue its TrueForge session.
import * as vscode from 'vscode';
import { plural } from '../shared/text';
import type { ChatHistory, SavedChat } from './history';

type Pick = SavedChat | 'inline' | 'session' | undefined;

export async function pickChat({ chats, inlineCount, current }: {
  chats: ChatHistory;
  inlineCount: number;
  current: string | undefined;
}): Promise<Pick> {
  const items: Array<vscode.QuickPickItem & { pick?: Pick }> = [];
  if (current) items.push({ label: '$(link-external) Open this chat in TrueForge', description: 'every step, as TrueForge recorded it', pick: 'session' });
  items.push({ label: 'Chats', kind: vscode.QuickPickItemKind.Separator });
  const saved = chats.list();
  if (!saved.length) items.push({ label: 'No earlier chats yet', description: 'a chat is saved after each reply' });
  for (const chat of saved) {
    const asks = chat.items.filter((i) => i.kind === 'user').length;
    items.push({
      label: chat.title,
      description: `${chat.sessionId === current ? 'this chat · ' : ''}${plural(asks, 'message')} · ${ago(chat.at)}`,
      pick: chat,
    });
  }
  items.push({ label: 'Inline edits', kind: vscode.QuickPickItemKind.Separator });
  items.push({ label: '$(edit) Inline edit history', description: plural(inlineCount, 'edit'), pick: 'inline' });
  const picked = await vscode.window.showQuickPick(items, { title: 'Anvil · History', matchOnDescription: true });
  return picked?.pick;
}

/** "just now", "5 min ago", "3 h ago", "2 days ago". */
function ago(at: number): string {
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return plural(Math.round(hours / 24), 'day') + ' ago';
}
