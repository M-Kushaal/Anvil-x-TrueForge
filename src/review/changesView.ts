// "Changes" tree: every pending file and change, with Keep / Reject inline actions.
import * as vscode from 'vscode';
import type { DraftStore } from '../drafts/store';
import type { Hunk } from '../drafts/hunks';

type Node = { kind: 'file'; path: string } | { kind: 'hunk'; path: string; hunk: Hunk; index: number };

export class ChangesView implements vscode.TreeDataProvider<Node> {
  static readonly id = 'anvil.changes';
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly drafts: DraftStore, private readonly absolute: (path: string) => string) {
    drafts.onChange(() => this.changed.fire());
  }

  getChildren(node?: Node): Node[] {
    if (!node) return this.drafts.summary().map((s) => ({ kind: 'file', path: s.path }));
    if (node.kind === 'file') return this.drafts.pending(node.path).map((hunk, index) => ({ kind: 'hunk', path: node.path, hunk, index }));
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'file') {
      const s = this.drafts.summary().find((x) => x.path === node.path);
      const item = new vscode.TreeItem(node.path.split('/').pop() ?? node.path, vscode.TreeItemCollapsibleState.Expanded);
      item.description = `${s?.isNew ? 'new · ' : ''}+${s?.added ?? 0} −${s?.removed ?? 0}`;
      item.tooltip = node.path;
      item.resourceUri = vscode.Uri.file(this.absolute(node.path)); // file icon and theme colour
      item.contextValue = 'anvilFile';
      item.command = { command: 'anvil.review', title: 'Review', arguments: [node.path] };
      return item;
    }
    const { hunk } = node;
    const sample = (hunk.newLines.find((l) => l.trim()) ?? hunk.oldLines.find((l) => l.trim()) ?? '').trim();
    const item = new vscode.TreeItem(sample.slice(0, 60) || '(blank lines)');
    item.description = `L${hunk.newStart + 1} · +${hunk.newLines.length} −${hunk.oldLines.length}`;
    item.iconPath = new vscode.ThemeIcon(hunk.oldLines.length === 0 ? 'diff-added' : hunk.newLines.length === 0 ? 'diff-removed' : 'diff-modified');
    item.contextValue = 'anvilHunk';
    item.command = { command: 'anvil.review', title: 'Review', arguments: [node.path] };
    return item;
  }
}
