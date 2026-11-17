// Ctrl+I: edit the selection in place. Instruction box → TrueForge run (scope-locked) → diff review.
import * as vscode from 'vscode';
import type { ReviewService } from '../review/review';
import type { ForgeEvent } from '../forge/timeline';
import { startInlineEdit, type InlineDeps, type InlineHandle, type InlineResult } from './run';

export interface InlineUiDeps extends InlineDeps {
  review: ReviewService;
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
  const hint = vscode.window.createTextEditorDecorationType({
    after: { margin: '0 0 0 2em', color: new vscode.ThemeColor('descriptionForeground'), fontStyle: 'normal' },
  });
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
  let active: InlineHandle | undefined;
  let lastInstruction = '';

  const setRunning = (running: boolean) => void vscode.commands.executeCommand('setContext', 'anvil.inlineRunning', running);

  const run = async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || active) return;
    const doc = editor.document;
    const path = deps.relPath(doc.uri.fsPath);
    if (!path) return void vscode.window.showWarningMessage('Anvil: inline edit works on files inside the open folder.');

    const { start, end } = selectedLines(editor);
    const name = path.split('/').pop();
    const instruction = await vscode.window.showInputBox({
      title: `Anvil · Edit ${name} L${start}–${end}`,
      placeHolder: 'Describe the change',
      value: lastInstruction,
      valueSelection: [0, lastInstruction.length],
      ignoreFocusOut: true,
    });
    if (!instruction?.trim()) return;
    lastInstruction = instruction;

    const range = new vscode.Range(start - 1, 0, end - 1, doc.lineAt(end - 1).text.length);
    editor.setDecorations(working, [range]);
    const showHint = (text: string) => editor.setDecorations(hint, [{ range: new vscode.Range(start - 1, 0, start - 1, 0), renderOptions: { after: { contentText: text } } }]);
    showHint('Anvil is editing… Esc to stop');
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
      if (size) showHint('Anvil is writing the change… Esc to stop');
    };
    const startOn = (model: string) => startInlineEdit({ deps, request, model, onEvent });
    active = deps.run ? deps.run(startOn) : startOn(deps.models()[0] ?? '');

    let result: InlineResult;
    try {
      result = await active.done;
    } finally {
      active = undefined;
      editor.setDecorations(working, []);
      editor.setDecorations(hint, []);
      status.hide();
      setRunning(false);
    }
    report(result, path, deps.review);
  };

  return vscode.Disposable.from(
    working,
    hint,
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
