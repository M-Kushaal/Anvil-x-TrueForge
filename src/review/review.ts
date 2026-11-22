// Hunk-by-hunk review in VS Code's diff editor: left = the real file, right = Anvil's proposal
// (a virtual document). CodeLens on the right offers Keep / Reject per change. Keep writes it to disk
// as an undoable edit; Reject drops it from the proposal. Nothing else ever writes.
import * as vscode from 'vscode';
import type { DraftStore, KeepPlan } from '../drafts/store';
import type { Hunk } from '../drafts/hunks';
import type { Workspace } from '../workspace/workspace';
import { deleteReal, readReal, writeReal } from './files';

const SCHEME = 'anvil-proposal';

interface HunkNode {
  path: string;
  hunk: Hunk;
}

interface Applied {
  baseBefore: string;
  baseAfter: string;
  path: string;
  before: string | undefined; // undefined = the file did not exist
  after: string;
  model: string;
}

export class ReviewService implements vscode.TextDocumentContentProvider, vscode.CodeLensProvider {
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  private readonly lensesChanged = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  readonly onDidChangeCodeLenses = this.lensesChanged.event;
  /** Kept changes, newest last, for Revert Last Kept Change. */
  private readonly appliedSets = new Map<string, Applied[]>();
  private activeSet = 'default';
  private operation = 0;
  private readonly rewindOperations: Array<{ id: number; files: Applied[] }> = [];

  beginOperation(): void { this.operation++; }

  private recordOperation(change: Applied): void {
    let operation = this.rewindOperations.at(-1);
    if (!operation || operation.id !== this.operation) {
      operation = { id: this.operation, files: [] };
      this.rewindOperations.push(operation);
    }
    const previous = operation.files.find((file) => file.path === change.path);
    if (previous) { previous.after = change.after; previous.baseAfter = change.baseAfter; }
    else operation.files.push({ ...change });
  }

  async rewindLastOperation(): Promise<void> {
    if (this.drafts.isLocked()) return this.notify('Wait for the current file operation to finish.');
    const operation = this.rewindOperations.at(-1);
    if (!operation) return this.notify('No edit operation is available to rewind in this extension session.');
    if (operation.files.some((file) => this.drafts.get(file.path))) {
      return this.notify('Keep or reject pending proposals in the affected files before rewinding.');
    }
    const releases = operation.files.map((file) => this.drafts.lock(file.path));
    let reverted = 0;
    try {
      for (const file of operation.files) {
        if (await readReal(this.ws, file.path) !== file.after) {
          return this.notify(`${file.path} changed after Keep. Rewind stopped before writing any files.`);
        }
      }
      for (const file of [...operation.files].reverse()) {
        if (file.before === undefined) await deleteReal(this.ws, file.path, file.after);
        else {
          const result = await writeReal(this.ws, file.path, file.before, { text: file.after });
          if (!result.saved) {
            file.after = file.before;
            throw new Error(`${file.path} was restored in the editor but could not be saved. Save it, then retry Rewind.`);
          }
        }
        operation.files.pop();
        reverted++;
        // Earlier single-Keep undo records for this operation no longer describe the real file.
        for (const ledger of this.appliedSets.values()) {
          for (let i = ledger.length - 1; i >= 0; i--) {
            const entry = ledger[i]!;
            if (entry.path === file.path && entry.after === file.after) ledger.splice(i, 1);
          }
        }
      }
      this.rewindOperations.pop();
      this.notify(`Rewound the last edit operation across ${reverted} file(s). Earlier operations can be rewound again.`);
    } catch (error) {
      this.notify(`Rewind stopped after restoring ${reverted} file(s): ${String(error)}`);
    } finally {
      for (const release of releases) release();
    }
  }

  private get applied(): Applied[] {
    let entries = this.appliedSets.get(this.activeSet);
    if (!entries) { entries = []; this.appliedSets.set(this.activeSet, entries); }
    return entries;
  }

  setChangeSet(id: string): void {
    if (id !== this.activeSet && this.drafts.isLocked()) throw new Error('Wait for the current change application before switching tasks.');
    this.activeSet = id;
  }

  constructor(private readonly ws: Workspace, private readonly drafts: DraftStore, private readonly notify: (message: string) => void) {
    drafts.onChange(() => this.refresh());
  }

  register(): vscode.Disposable {
    const selector = { scheme: SCHEME };
    const cmd = vscode.commands.registerCommand;
    return vscode.Disposable.from(
      vscode.workspace.registerTextDocumentContentProvider(SCHEME, this),
      vscode.languages.registerCodeLensProvider(selector, this),
      // From CodeLens: (path, id). From the Changes tree: a hunk node.
      cmd('anvil.keepHunk', (a: string | HunkNode, id?: string) => typeof a === 'string' ? this.keep(a, [id ?? '']) : this.keep(a.path, [a.hunk.id])),
      cmd('anvil.undoHunk', (a: string | HunkNode, id?: string) => typeof a === 'string' ? this.undo(a, [id ?? '']) : this.undo(a.path, [a.hunk.id])),
      cmd('anvil.keepFile', (target?: string | { path?: string }) => this.keep(pathOf(target) ?? this.activePath() ?? '', 'all')),
      cmd('anvil.undoFile', (target?: string | { path?: string }) => this.undo(pathOf(target) ?? this.activePath() ?? '', 'all')),
      cmd('anvil.keepAll', () => this.keepAll()),
      cmd('anvil.discardAll', () => this.discardAll()),
      cmd('anvil.review', (target?: string | { path?: string }) => this.open(pathOf(target))),
      cmd('anvil.keepAtCursor', () => this.atCursor('keep')),
      cmd('anvil.undoAtCursor', () => this.atCursor('undo')),
      cmd('anvil.nextHunk', () => this.step(1)),
      cmd('anvil.prevHunk', () => this.step(-1)),
      cmd('anvil.undoLastApply', () => this.undoLastApply()),
    );
  }

  // ---- virtual proposal document ----------------------------------------------------------

  provideTextDocumentContent(uri: vscode.Uri): string {
    if (uri.query === 'empty') return ''; // left side when reviewing a new file
    return this.drafts.view(proposalPath(uri)) ?? '';
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const path = proposalPath(doc.uri);
    const hunks = this.drafts.pending(path);
    return hunks.flatMap((hunk, i) => {
      const line = Math.min(hunk.newStart, Math.max(doc.lineCount - 1, 0));
      const range = new vscode.Range(line, 0, line, 0);
      return [
        new vscode.CodeLens(range, { title: '$(check) Keep', command: 'anvil.keepHunk', arguments: [path, hunk.id], tooltip: 'Write this change to the file (Ctrl+Enter)' }),
        new vscode.CodeLens(range, { title: '$(close) Reject', command: 'anvil.undoHunk', arguments: [path, hunk.id], tooltip: 'Reject this change (Ctrl+Backspace)' }),
        new vscode.CodeLens(range, { title: `${i + 1} of ${hunks.length} · +${hunk.newLines.length} −${hunk.oldLines.length}`, command: '' }),
      ];
    });
  }

  // ---- actions ------------------------------------------------------------------------------

  async open(path?: string): Promise<void> {
    const target = path ?? this.drafts.summary()[0]?.path;
    if (!target) return this.notify('Nothing to review.');
    const draft = this.drafts.get(target);
    if (!draft) return;
    const right = proposalUri(target);
    const left = draft.isNew ? proposalUri(target, 'empty') : vscode.Uri.file(this.ws.resolve(target));
    const count = this.drafts.pending(target).length;
    await vscode.commands.executeCommand('vscode.diff', left, right, `${basename(target)} ↔ Anvil proposal (${count} pending)`, { preview: false });
    const editor = vscode.window.activeTextEditor;
    const first = this.drafts.pending(target)[0];
    if (editor && first) editor.revealRange(new vscode.Range(first.newStart, 0, first.newStart, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  async keep(path: string, ids: string[] | 'all'): Promise<boolean> {
    if (this.drafts.isLocked(path)) {
      this.notify(`${path} is being applied. Wait for Keep to finish.`);
      return false;
    }
    const release = this.drafts.lock(path);
    try {
      return await this.keepNow(path, ids);
    } finally {
      release();
    }
  }

  private async keepNow(path: string, ids: string[] | 'all'): Promise<boolean> {
    const draft = this.drafts.get(path);
    if (!draft) return false;
    const before = await readReal(this.ws, path);
    if (draft.isNew && before !== undefined) {
      this.notify(`${path} was created after this proposal. It remains pending; review it again.`);
      return false;
    }
    const plan = this.drafts.planKeep(path, ids, before ?? '');
    if (!plan.ok) {
      this.notify(plan.error);
      return false;
    }
    return this.applyPlan(path, before, draft.model, plan);
  }

  private async applyPlan(path: string, before: string | undefined, model: string, plan: Extract<KeepPlan, { ok: true }>): Promise<boolean> {
    // Preflight may have read this file before other files. Do not overwrite intervening edits.
    if (await readReal(this.ws, path) !== before) {
      this.notify(`${path} changed while preparing Keep. It remains pending; review it again.`);
      return false;
    }
    let saved: boolean;
    try {
      ({ saved } = await writeReal(this.ws, path, plan.text, { text: before }));
    } catch (error) {
      this.notify(`Could not finish writing ${path}: ${String(error)}. Check the file; its proposal remains pending.`);
      return false;
    }
    this.applied.push({ path, before, after: plan.text, model, baseBefore: plan.baseBefore, baseAfter: plan.baseAfter });
    this.recordOperation({ path, before, after: plan.text, model, baseBefore: plan.baseBefore, baseAfter: plan.baseAfter });
    plan.commit();
    if (!saved) this.notify(`Kept ${path} in the editor. It has unsaved changes; save the file manually.`);
    return true;
  }

  undo(path: string, ids: string[] | 'all'): void {
    if (!this.drafts.undo(path, ids)) this.notify(`${path} is being applied. Wait for Keep to finish before rejecting it.`);
  }

  async keepAll(): Promise<void> {
    const paths = this.drafts.summary().map((file) => file.path);
    if (!paths.length) return this.notify('Nothing to keep.');
    if (this.drafts.isLocked()) return this.notify('Changes are being applied. Wait for Keep to finish.');
    const releases = paths.map((path) => this.drafts.lock(path));
    try {
      const plans: Array<{ path: string; before: string | undefined; model: string; plan: Extract<KeepPlan, { ok: true }> }> = [];
      for (const path of paths) {
        const draft = this.drafts.get(path)!;
        const before = await readReal(this.ws, path);
        if (draft.isNew && before !== undefined) return this.notify(`Keep all stopped before writing any files: ${path} was created after its proposal.`);
        const plan = this.drafts.planKeep(path, 'all', before ?? '');
        if (!plan.ok) return this.notify(`Keep all stopped before writing any files: ${plan.error}`);
        plans.push({ path, before, model: draft.model, plan });
      }
      let applied = 0;
      for (const { path, before, model, plan } of plans) {
        if (!await this.applyPlan(path, before, model, plan)) {
          this.notify(`Keep all stopped: ${applied} of ${paths.length} files applied; ${paths.length - applied} files remain pending. Review them before retrying.`);
          return;
        }
        applied++;
      }
      this.notify(`Kept changes in ${applied} ${applied === 1 ? 'file' : 'files'}.`);
    } finally {
      for (const release of releases) release();
    }
  }

  discardAll(): void {
    if (!this.drafts.discardAll()) this.notify('Changes are being applied. Wait for Keep to finish before rejecting them.');
  }

  /** Reverts the most recent Keep (also available as plain Ctrl+Z in the file). */
  async undoLastApply(): Promise<void> {
    if (this.drafts.isLocked()) return this.notify('Changes are being applied. Wait for Keep to finish before reverting them.');
    const ledger = this.applied;
    const last = ledger.at(-1);
    if (!last) return this.notify('No kept change to revert.');
    const release = this.drafts.lock(last.path);
    ledger.pop();
    try {
      const current = await readReal(this.ws, last.path);
      if (current !== last.after) {
        ledger.push(last);
        return this.notify(`${last.path} has changed since that change was kept. Use Ctrl+Z in the file instead.`);
      }
      const pending = this.drafts.get(last.path);
      if (pending && pending.base !== last.baseAfter) {
        ledger.push(last);
        return this.notify(`Pending changes for ${last.path} use a different base. Resolve them before reverting the kept change.`);
      }
      let saved = true;
      if (last.before === undefined) await deleteReal(this.ws, last.path, last.after);
      else ({ saved } = await writeReal(this.ws, last.path, last.before, { text: last.after }));
      // Release only after all I/O. Reopening below is synchronous and deliberately mutates the
      // proposal; other stage/reject/task-switch operations were blocked throughout the write.
      release();
      this.drafts.reopen({ path: last.path, before: last.baseBefore, after: last.baseAfter, model: last.model, isNew: last.before === undefined });
      this.notify(`Reverted the last kept change in ${last.path}. It is pending again.${saved ? '' : ' The file has unsaved changes; save it manually.'}`);
    } catch (error) {
      ledger.push(last);
      this.notify(`Could not revert ${last.path}: ${String(error)}. Check the file before retrying.`);
    } finally {
      release();
    }
  }

  // ---- helpers --------------------------------------------------------------------------------

  private refresh(): void {
    for (const doc of vscode.workspace.textDocuments) if (doc.uri.scheme === SCHEME) this.changed.fire(doc.uri);
    this.lensesChanged.fire();
    void this.closeResolved();
  }

  /** Closes review tabs whose file has no pending hunks left. */
  private async closeResolved(): Promise<void> {
    const pending = new Set(this.drafts.summary().map((s) => s.path));
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((tab) => {
      const input = tab.input;
      return input instanceof vscode.TabInputTextDiff && input.modified.scheme === SCHEME && !pending.has(proposalPath(input.modified));
    });
    if (tabs.length) await vscode.window.tabGroups.close(tabs);
  }

  private activePath(): string | undefined {
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (uri?.scheme === SCHEME) return proposalPath(uri);
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    return input instanceof vscode.TabInputTextDiff && input.modified.scheme === SCHEME
      ? proposalPath(input.modified) : undefined;
  }

  private hunkAtCursor(): { path: string; hunk: Hunk } | undefined {
    const editor = vscode.window.activeTextEditor;
    const path = this.activePath();
    if (!editor || !path) return undefined;
    const line = editor.selection.active.line;
    const hunks = this.drafts.pending(path);
    const hunk = hunks.find((h) => line >= h.newStart && line < h.newStart + Math.max(h.newLines.length, 1))
      ?? hunks.find((h) => h.newStart >= line) ?? hunks.at(-1);
    return hunk ? { path, hunk } : undefined;
  }

  private async atCursor(action: 'keep' | 'undo'): Promise<void> {
    const found = this.hunkAtCursor();
    if (!found) return;
    if (action === 'keep') await this.keep(found.path, [found.hunk.id]);
    else this.undo(found.path, [found.hunk.id]);
  }

  private step(direction: 1 | -1): void {
    const editor = vscode.window.activeTextEditor;
    const path = this.activePath();
    if (!editor || !path) return;
    const line = editor.selection.active.line;
    const starts = this.drafts.pending(path).map((h) => h.newStart);
    const target = direction === 1 ? starts.find((s) => s > line) ?? starts[0] : [...starts].reverse().find((s) => s < line) ?? starts.at(-1);
    if (target === undefined) return;
    editor.selection = new vscode.Selection(target, 0, target, 0);
    editor.revealRange(new vscode.Range(target, 0, target, 0), vscode.TextEditorRevealType.InCenter);
  }
}

export function proposalUri(path: string, side: 'proposal' | 'empty' = 'proposal'): vscode.Uri {
  return vscode.Uri.from({ scheme: SCHEME, path: `/${path}`, query: side });
}

function proposalPath(uri: vscode.Uri): string {
  return uri.path.replace(/^\//, '');
}

function pathOf(target: string | { path?: string; scheme?: string } | undefined): string | undefined {
  if (typeof target === 'string') return target;
  if (target?.scheme === SCHEME && target.path) return target.path.replace(/^\//, '');
  return target?.scheme ? undefined : target?.path;
}

function basename(path: string): string {
  return path.split('/').pop() ?? path;
}
