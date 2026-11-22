// Ctrl+I: edit the selection in place. Instruction box → TrueForge run (scope-locked) → diff review.
import * as vscode from 'vscode';
import type { ReviewService } from '../review/review';
import type { ForgeEvent } from '../forge/timeline';
import { startInlineEdit, type InlineDeps, type InlineHandle, type InlineResult } from './run';

export interface InlineUiDeps extends InlineDeps {
  review: ReviewService;
  onFinished?: (path: string, pending: number) => void;
  askInstruction: (selection: { file: string; start: number; end: number }) => Promise<string | undefined>;
  models: () => string[];
  relPath: (abs: string) => string | undefined;
  /** Wraps the run with retry and model fallback (see withFallback). */
  run?: (start: (model: string) => InlineHandle) => InlineHandle;
}

export function registerInlineEdit(deps: InlineUiDeps): vscode.Disposable {
  const working = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    borderWidth: '0 0 0 2px',
    borderStyle: 'solid',
    borderColor: new vscode.ThemeColor('anvil.accent'),
    backgroundColor: new vscode.ThemeColor('anvil.workingBackground'),
  });
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
  let active: InlineHandle | undefined;
  let selectionRequest = 0;

  const setRunning = (running: boolean) => void vscode.commands.executeCommand('setContext', 'anvil.inlineRunning', running);

  const run = async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || active) return;
    const doc = editor.document;
    let path: string | undefined;
    if (doc.uri.scheme === 'anvil-proposal') {
      if (doc.uri.query === 'empty') {
        return void vscode.window.showInformationMessage('Select code on the proposal side of the diff to edit it.');
      }
      const relative = doc.uri.path.replace(/^\//, '');
      path = deps.edits.normalize ? deps.edits.normalize(relative) : relative;
    } else if (doc.uri.scheme === 'file') {
      path = deps.relPath(doc.uri.fsPath);
    }
    if (!path) return void vscode.window.showWarningMessage(
      'Open a source file from this window?s Explorer before using Anvil inline edit. A file from a previous debug workspace belongs to a different folder.');

    const { start, end } = selectedLines(editor);
    const version = doc.version;
    const name = path.split('/').pop();
    const requestId = ++selectionRequest;
    const instruction = await deps.askInstruction({ file: name ?? path, start, end });
    if (requestId !== selectionRequest || active) return;
    if (!instruction?.trim()) { deps.onFinished?.(path, 0); return; }
    if (doc.isClosed || doc.version !== version) {
      deps.onFinished?.(path, 0);
      return void vscode.window.showWarningMessage('Anvil: the document changed. Select the code again before editing.');
    }
    await vscode.window.showTextDocument(doc, { viewColumn: editor.viewColumn, preserveFocus: false });
    if (requestId !== selectionRequest || active) return;

    const range = new vscode.Range(start - 1, 0, end - 1, doc.lineAt(end - 1).text.length);
    editor.setDecorations(working, [range]);
    status.text = `$(sync~spin) Anvil · editing ${name}`;
    status.tooltip = 'Esc or Ctrl+Shift+Backspace to stop';
    status.show();
    setRunning(true);

    const request = {
      path,
      startLine: start,
      endLine: end,
      instruction,
      text: deps.edits.drafts.view(path) ?? doc.getText().replace(/\r\n/g, '\n'),
      language: doc.languageId,
    };
    const onEvent = (event: ForgeEvent) => {
      const size = streamedArgs(event);
      if (size) status.text = `$(sync~spin) Anvil writing ${name}`;
    };
    const startOn = (model: string) => startInlineEdit({ deps, request, model, onEvent });
    active = deps.run ? deps.run(startOn) : startOn(deps.models()[0] ?? '');

    let result: InlineResult;
    try {
      result = await active.done;
    } finally {
      active = undefined;
      editor.setDecorations(working, []);
      status.hide();
      setRunning(false);
    }
    report(result, path, deps.review);
    deps.onFinished?.(path, result.pending);
  };

  return vscode.Disposable.from(
    working,
    status,
    { dispose: () => active?.cancel() },
    vscode.commands.registerCommand('anvil.inlineEdit', run),
    vscode.commands.registerCommand('anvil.cancelInline', () => active?.cancel()),
  );
}

/** 1-based inclusive lines of the selection; an empty selection means the current line. */
function selectedLines(editor: vscode.TextEditor): { start: number; end: number } {
  const { start, end } = editor.selection;
  const last = end.character === 0 && end.line > start.line ? end.line - 1 : end.line;
  return { start: start.line + 1, end: last + 1 };
}

function streamedArgs(event: ForgeEvent): number {
  if (event.type !== 'model.message' || !Array.isArray(event.toolCalls)) return 0;
  return (event.toolCalls as Array<{ function?: { arguments?: string } }>).reduce((n, c) => n + (c.function?.arguments?.length ?? 0), 0);
}

function report(result: InlineResult, path: string, review: ReviewService): void {
  const { outcome, pending } = result;
  if (pending > 0) {
    void review.open(path);
    if (outcome.status !== 'done') void vscode.window.showWarningMessage('Anvil: the run ended early, but the change is ready for review.');
    return;
  }
  if (outcome.status === 'cancelled') return void vscode.window.showInformationMessage('Anvil: edit stopped.');
  if (outcome.status === 'error') return void vscode.window.showErrorMessage(`Anvil: ${outcome.message ?? 'the edit failed'}. Your files are unchanged.`);
  void vscode.window.showInformationMessage('Anvil: no change was needed for the selection.');
}
