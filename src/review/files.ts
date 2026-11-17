// Real-file I/O for review. Texts are handled with LF internally; writes keep each file's EOL.
import * as vscode from 'vscode';
import type { Workspace } from '../workspace/workspace';

export async function readReal(ws: Workspace, path: string): Promise<string | undefined> {
  const uri = vscode.Uri.file(ws.resolve(path));
  const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
  if (open) return open.getText().replace(/\r\n/g, '\n');
  try {
    return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8').replace(/\r\n/g, '\n');
  } catch {
    return undefined;
  }
}

/** Writes `text` (LF) to the file as one minimal, undoable edit, then saves unless the user had unsaved edits. Creates the file if needed. */
export async function writeReal(ws: Workspace, path: string, text: string, expected?: { text: string | undefined }): Promise<{ saved: boolean }> {
  const uri = vscode.Uri.file(ws.resolve(path));
  const exists = await vscode.workspace.fs.stat(uri).then(() => true, () => false);
  if (expected && exists !== (expected.text !== undefined)) throw new Error(`${path} was created or removed while preparing the change.`);
  if (!exists) {
    const edit = new vscode.WorkspaceEdit();
    edit.createFile(uri, { overwrite: false, ignoreIfExists: false, contents: Buffer.from(text, 'utf8') });
    if (!(await vscode.workspace.applyEdit(edit))) throw new Error(`Could not create ${path}`);
    ws.invalidate();
    return { saved: true };
  }
  const doc = await vscode.workspace.openTextDocument(uri);
  const hadUnsavedWork = doc.isDirty;
  const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const current = doc.getText();
  if (expected && current.replace(/\r\n/g, '\n') !== expected.text) throw new Error(`${path} changed while preparing the change.`);
  const next = text.replace(/\n/g, eol);
  if (current === next) return { saved: !doc.isDirty };
  const { start, endOld, endNew } = changedRange(current, next);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, new vscode.Range(doc.positionAt(start), doc.positionAt(endOld)), next.slice(start, endNew));
  if (!(await vscode.workspace.applyEdit(edit))) throw new Error(`Could not edit ${path}`);
  // Saving would also save the user's own unsaved edits in this file; then leave saving to them.
  if (hadUnsavedWork) return { saved: false };
  try {
    return { saved: await doc.save() };
  } catch (error) {
    // Applying the edit succeeded. A failed save must not leave its draft pending and allow
    // a retry to apply an insertion twice. Report the buffer application separately from saving.
    if (doc.getText() === next) return { saved: false };
    throw error;
  }
}

export async function deleteReal(ws: Workspace, path: string): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  edit.deleteFile(vscode.Uri.file(ws.resolve(path)), { ignoreIfNotExists: true });
  if (!await vscode.workspace.applyEdit(edit)) throw new Error(`Could not remove ${path}`);
  ws.invalidate();
}

/** Common prefix/suffix trim, so the edit (and its undo step) covers only what changed. */
function changedRange(a: string, b: string): { start: number; endOld: number; endNew: number } {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let suffix = 0;
  while (suffix < a.length - start && suffix < b.length - start && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  return { start, endOld: a.length - suffix, endNew: b.length - suffix };
}
