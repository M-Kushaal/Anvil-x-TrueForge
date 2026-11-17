// Activation and wiring only; behaviour lives in the modules it connects.
import * as vscode from 'vscode';
import path from 'node:path';
import { readConfig } from './config';
import { ChatController } from './chat/controller';
import { ChatHistory } from './chat/history';
import { pickChat } from './chat/historyView';
import { ChatView } from './chat/view';
import { ContextEngine } from './context/engine';
import { buildGraph, loadGraph } from './context/graphify';
import { toContextView } from './context/view';
import { DraftStore } from './drafts/store';
import { ChangeSets } from './drafts/changeSets';
import { CommandPermissions, EditPermissions } from './mcp/permissions';
import { CONNECTOR_NAME, ForgeClient, type ApprovalRequest, type Decision } from './forge/client';
import { registerConnector } from './forge/connector';
import { registerInlineEdit } from './inline/inlineEdit';
import { InlineHistory } from './inline/history';
import { showInlineHistory } from './inline/historyView';
import { withFallback } from './inline/run';
import { commandTools, killRunningCommands } from './mcp/commandTools';
import { contextTools } from './mcp/contextTools';
import { editTools, validateEdit, EDIT_TOOL_NAMES, type EditContext } from './mcp/editTools';
import { planTool } from './mcp/planTool';
import { readTools } from './mcp/readTools';
import { startMcpServer } from './mcp/server';
import { limitsFor, specFor } from './models/limits';
import type { Mention } from './context/pack';
import { ChangesView } from './review/changesView';
import { readReal } from './review/files';
import { ReviewService } from './review/review';
import type { FromWebview } from './shared/protocol';
import { plural } from './shared/text';
import { createWorkspace, isIndexablePath } from './workspace/workspace';

/** Internals exposed to the e2e tests (and nothing else). */
export interface AnvilApi {
  drafts: DraftStore;
  review: ReviewService;
  controller: ChatController;
}

export async function activate(context: vscode.ExtensionContext): Promise<AnvilApi | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return undefined; // Anvil works on an open folder
  const root = folder.uri.fsPath;
  const rel = (abs: string) => path.relative(root, abs).split(path.sep).join('/');
  const log = vscode.window.createOutputChannel('Anvil');

  // Workspace and context. The agent reads its own staged drafts first, then unsaved buffers, then disk.
  const drafts = new DraftStore();
  const changeSets = new ChangeSets(context.workspaceState, drafts, (error) => {
    log.appendLine(`Could not persist changes: ${String(error)}`);
    void vscode.window.showErrorMessage('Anvil could not save pending changes. Keep this window open and retry before reloading.');
  });
  const permissions = new CommandPermissions();
  const editPermissions = new EditPermissions();
  let workspaceRevision = 0;
  let pinnedContext: string[] = [];
  let excludedContext: string[] = [];
  const snapshotId = () => `${changeSets.activeId}:${drafts.revision}:${workspaceRevision}`;
  const workspace = createWorkspace({
    root,
    liveText: (abs) => drafts.view(rel(abs))
      ?? vscode.workspace.textDocuments.find((d) => d.uri.fsPath === abs && d.isDirty)?.getText().replace(/\r\n/g, '\n'),
  });
  const engine = new ContextEngine(workspace);
  void engine.build().then(() => log.appendLine(`Indexed ${engine.fileCount} files.`));
  void startGraph(context, engine, root, log);
  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  const reindex = (uri: vscode.Uri) => {
    const r = rel(uri.fsPath);
    if (!r.startsWith('..') && isIndexablePath(r)) {
      engine.invalidate(r);
      workspaceRevision++;
      controller.invalidateVerification();
    }
  };
  watcher.onDidCreate((uri) => { workspace.invalidate(); reindex(uri); });
  watcher.onDidDelete((uri) => { workspace.invalidate(); reindex(uri); });
  watcher.onDidChange(reindex);
  const review = new ReviewService(workspace, drafts, (message) => void vscode.window.showInformationMessage(`Anvil: ${message}`));

  // TrueForge and the editor tools it calls over MCP.
  const { client, sdk } = ForgeClient.connect(readConfig().serverUrl);
  const edits: EditContext = {
    generation: () => permissions.epoch,
    authorize: (name, args) => editPermissions.grant(name, args),
    drafts,
    realText: (p) => readReal(workspace, p),
    model: () => controller.snapshot.model,
    normalize: (p) => rel(workspace.resolve(p)),
  };
  const host = await startMcpServer({
    tools: () => [
      ...readTools(workspace),
      ...contextTools(engine),
      ...editTools(edits).map((tool) => ({ ...tool, run: async (args: unknown) => editPermissions.consume(tool.name, args)
        ? tool.run(args) : 'Error: edit approval expired or was not granted. Request approval again.' })),
      ...commandTools({
        ws: workspace, drafts,
        extraPath: () => readConfig().commandPath.map((p) => path.resolve(root, p)),
        snapshotId,
        snapshot: () => vscode.workspace.textDocuments.filter((d) => d.isDirty && d.uri.scheme === 'file')
          .map((d) => ({ path: rel(d.uri.fsPath), text: d.getText().replace(/\r\n/g, '\n') }))
          .filter((d) => !d.path.startsWith('..') && !path.isAbsolute(d.path)),
        onResult: (result) => {
          if (!result.snapshotId?.startsWith(`${changeSets.activeId}:`)) return;
          controller.setVerification({
            command: result.command, code: result.code, output: result.output, at: Date.now(), snapshotId: result.snapshotId,
            status: result.snapshotId !== snapshotId() ? 'outdated' : result.cancelled ? 'cancelled' : result.timedOut ? 'timedOut' : result.code === 0 ? 'passed' : 'failed',
          });
        },
      }).map((tool) => ({ ...tool, run: async (args: unknown) => permissions.consume(args)
        ? tool.run(args) : 'Error: command has no current one-use approval. Request approval again.' })),
      planTool((steps) => controller.setPlan(steps)),
    ],
  });
  let registered: Promise<void> | undefined;
  // One connector per workspace, so two windows never route each other's tool calls.
  const connector = `${CONNECTOR_NAME}-${hashPath(root)}`;
  const modelSpec = (model: string) => ({ ...specFor(model, readConfig()), connector });
  const serverUrl = readConfig().serverUrl;
  const ensureReady = (): Promise<void> => (registered ??= registerConnector(sdk, host, connector, serverUrl).then(
    async () => {
      const { data } = await sdk.models.list({ timeoutInSeconds: 10 });
      const primary = readConfig().models[0];
      if (!primary || !data.some((m) => m.name === primary)) {
        registered = undefined;
        const message = primary ? `Model ${primary} is not registered. Run npm run setup in Anvil or choose a registered model.` : 'No model configured. Open Setup and add anvil.models.';
        controller.setConnection({ ok: false, message });
        throw new Error(message);
      }
      controller.setConnection({ ok: true });
    },
  ).catch((error: unknown) => {
      registered = undefined; // retry on the next request
      controller.setConnection({ ok: false, message: error instanceof Error ? error.message : String(error) });
      throw error;
    },
  ));
  /** Commands waiting for Run or Skip on their row in the chat, by tool call id. */
  const waiting = new Map<string, (allow: boolean) => void>();
  const askInChat = (id: string) => new Promise<boolean>((resolve) => {
    waiting.set(id, resolve);
    void vscode.commands.executeCommand('anvil.focus');
  });
  /** TrueForge's approval gate: edits are validated here and denied with a precise reason. */
  const onApproval = async ({ name, args, toolCallId }: ApprovalRequest): Promise<Decision> => {
    if ((EDIT_TOOL_NAMES as readonly string[]).includes(name)) {
      const epoch = permissions.epoch;
      const error = await validateEdit(edits, name, args);
      if (epoch !== permissions.epoch) return { status: 'deny', reason: 'The task was stopped or replaced.' };
      if (!error) editPermissions.grant(name, args);
      return error ? { status: 'deny', reason: error } : { status: 'allow' };
    }
    if (name === 'run_command') {
      const epoch = permissions.epoch;
      const decision = await approveCommand(args, () => askInChat(toolCallId));
      return decision.status === 'allow' && !permissions.grant(args, epoch)
        ? { status: 'deny', reason: 'The task was stopped or replaced. Request approval again.' } : decision;
    }
    return { status: 'deny', reason: `${name} is not enabled in Anvil.` };
  };

  // Inline edits: one shared TrueForge session per workspace, listed in the history.
  const history = new InlineHistory(context.workspaceState);
  const chats = new ChatHistory(context.workspaceState);

  // The chat. The view is created below; state posted before then is re-sent when it reports 'ready'.
  let view: ChatView | undefined;
  const controller: ChatController = new ChatController({
    initialChangeSetId: changeSets.activeId,
    onStop: () => {
      permissions.revoke();
      editPermissions.revoke();
      killRunningCommands();
      for (const resolve of waiting.values()) resolve(false);
      waiting.clear();
      void vscode.commands.executeCommand('anvil.cancelInline');
    },
    onChangeSet: (id, title) => {
      changeSets.activate(id, title);
      pinnedContext = [];
      excludedContext = [];
      controller.setContextFiles([]);
      controller.setContextExcluded([]);
      review.setChangeSet(id);
      controller.setCheckpointAvailable(changeSets.hasCheckpoint);
    },
    client,
    models: () => readConfig().allowModelFallback ? readConfig().models : readConfig().models.slice(0, 1),
    post: (state) => view?.post(state), // the view sends 'ready' and gets the latest state then
    onApproval,
    ensureReady,
    specFor: modelSpec,
    onTurnEnd: (sessionId, state) => { changeSets.rename(state.title); void chats.save(sessionId, state); },
    contextFor: async (prompt) => {
      const config = readConfig();
      await engine.prepare();
      const { contextBudget } = limitsFor(controller.snapshot.model || config.models[0] || '', config);
      const editor = editorMention(prompt);
      const mentions = [...pinnedContext, ...(editor ? [editor] : []), ...engine.resolveMentions(prompt)];
      const pack = await engine.pack(prompt, { budget: contextBudget, mentions, exclude: excludedContext });
      return { text: pack.text, view: toContextView(pack, engine) };
    },
  });
  let previousDraftPaths = drafts.all().map((d) => d.path);
  drafts.onChange(() => {
    const paths = drafts.all().map((d) => d.path);
    for (const p of new Set([...previousDraftPaths, ...paths])) engine.invalidate(p);
    previousDraftPaths = paths;
    controller.setChanges(drafts.summary());
    controller.invalidateVerification();
  });
  controller.setChanges(drafts.summary());
  review.setChangeSet(changeSets.activeId);
  controller.setCheckpointAvailable(changeSets.hasCheckpoint);
  const stopAll = () => {
    controller.stop();
  };
  const canSwitch = () => {
    if (!drafts.isLocked()) return true;
    void vscode.window.showInformationMessage('Anvil: wait for the current Keep operation before switching tasks.');
    return false;
  };
  const selectModel = async () => {
    if (controller.snapshot.running) return;
    const config = readConfig();
    const available = await sdk.models.list({ timeoutInSeconds: 5 }).then(({ data }) => data.map((m) => m.name)).catch(() => [] as string[]);
    const picked = await vscode.window.showQuickPick([...new Set([...available, ...config.models]), 'Configure models…'], { title: 'Anvil · Model for a new chat', placeHolder: 'Other configured models remain fallbacks unless disabled in settings' });
    if (picked === 'Configure models…') return void vscode.commands.executeCommand('workbench.action.openSettings', 'anvil.models');
    if (picked && canSwitch()) {
      await vscode.workspace.getConfiguration('anvil').update('models', [picked, ...config.models.filter((m) => m !== picked)], vscode.ConfigurationTarget.Global);
      controller.newChat();
    }
  };
  const attachContext = async () => {
    await engine.prepare();
    const files = await workspace.files();
    const picked = await vscode.window.showQuickPick(files.map((p) => ({ label: p, picked: pinnedContext.includes(p) })), { title: 'Anvil · Files to include with the next request', canPickMany: true, matchOnDescription: true });
    if (picked) {
      pinnedContext = picked.map((p) => p.label);
      excludedContext = excludedContext.filter((p) => !pinnedContext.includes(p));
      controller.setContextFiles(pinnedContext);
      controller.setContextExcluded(excludedContext);
    }
  };
  /** The selection, or the open file when the request points at it ("this", "here"), as a mention. */
  const editorMention = (prompt: string): Mention | undefined => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') return undefined;
    const file = rel(editor.document.uri.fsPath);
    if (file.startsWith('..') || path.isAbsolute(file)) return undefined;
    // Only when the request points at it: a selection left over from earlier must not steer an
    // unrelated request (for example, naming a file the task did not name).
    if (!/\b(this|these|here|selected|selection|current|open)\b/i.test(prompt)) return undefined;
    const { selection } = editor;
    if (!selection.isEmpty) {
      return { path: file, line: selection.start.line + 1, end: selection.end.line + 1, reason: `your selection, lines ${selection.start.line + 1}-${selection.end.line + 1}` };
    }
    return { path: file, line: selection.active.line + 1, reason: `open in the editor, near line ${selection.active.line + 1}` };
  };
  /** Earlier chats and the inline-edit history, in one list. */
  const openHistory = async () => {
    const picked = await pickChat({ chats, inlineCount: history.entries().length, current: controller.currentSession });
    if (picked === 'inline') return showInlineHistory(history, client, root);
    if (picked === 'session') {
      const id = controller.currentSession;
      if (id) void vscode.env.openExternal(vscode.Uri.parse(client.sessionUrl(id)));
      return;
    }
    if (picked && canSwitch()) controller.resume(picked);
  };
  view = new ChatView(context.extensionUri, (message: FromWebview) => {
    switch (message.type) {
      case 'ready': return controller.refresh();
      case 'send': return void controller.send(message.text);
      case 'stop': return stopAll();
      case 'newChat': return canSwitch() ? controller.newChat() : undefined;
      case 'history': return void openHistory();
      case 'review': return void review.open(message.path);
      case 'keepAll': return void review.keepAll();
      case 'discardAll': return review.discardAll();
      case 'settings': return void vscode.commands.executeCommand('workbench.action.openSettings', 'anvil');
      case 'selectModel': return void selectModel();
      case 'attachContext': return void attachContext();
      case 'removeContext': {
        pinnedContext = pinnedContext.filter((p) => p !== message.path);
        return controller.setContextFiles(pinnedContext);
      }
      case 'pinContext': {
        workspace.resolve(message.path);
        pinnedContext = [...new Set([...pinnedContext, message.path])];
        excludedContext = excludedContext.filter((p) => p !== message.path);
        controller.setContextExcluded(excludedContext);
        return controller.setContextFiles(pinnedContext);
      }
      case 'excludeContext': {
        excludedContext = [...new Set([...excludedContext, message.path])];
        pinnedContext = pinnedContext.filter((p) => p !== message.path);
        controller.setContextFiles(pinnedContext);
        return controller.setContextExcluded(excludedContext);
      }
      case 'restoreContext': {
        excludedContext = excludedContext.filter((p) => p !== message.path);
        return controller.setContextExcluded(excludedContext);
      }
      case 'checkpoint':
        changeSets.checkpoint();
        return controller.setCheckpointAvailable(true);
      case 'restoreCheckpoint':
        if (!controller.snapshot.running && !drafts.isLocked()) changeSets.restoreCheckpoint();
        return;
      case 'recoverChanges': {
        void vscode.window.showQuickPick(changeSets.list().map((s) => ({ label: s.title, description: `${s.files} pending files`, id: s.id })), { title: 'Anvil · Recover pending task' })
          .then((picked) => { if (picked && canSwitch()) controller.recoverChangeSet(picked.id, picked.label); });
        return;
      }
      case 'reconnect': {
        registered = undefined;
        return void ensureReady().catch(() => undefined);
      }
      case 'approve': {
        if (waiting.has(message.id)) controller.markTool(message.id, message.allow ? 'running' : 'stopped');
        waiting.get(message.id)?.(message.allow);
        waiting.delete(message.id);
        return;
      }
      case 'openFile': {
        const line = Math.max(0, (message.line ?? 1) - 1);
        void vscode.window.showTextDocument(vscode.Uri.file(workspace.resolve(message.path)), { selection: new vscode.Range(line, 0, line, 0), preview: true });
        return;
      }
    }
  });

  // Status bar: what is pending, at a glance.
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'anvil.focus';
  const renderStatus = () => {
    const pending = drafts.summary().reduce((n, c) => n + c.hunks, 0);
    if (!pending) return status.hide();
    status.text = `$(diff) Anvil: ${pending} pending`;
    status.tooltip = `${plural(pending, 'change')} waiting for review. Click to review.`;
    status.show();
  };
  drafts.onChange(renderStatus);
  renderStatus();

  context.subscriptions.push(
    watcher,
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.scheme === 'file' && event.contentChanges.length) reindex(event.document.uri);
    }),
    status,
    log,
    { dispose: () => void host.close() },
    { dispose: () => { stopAll(); void changeSets.flush(); } },
    review.register(),
    registerInlineEdit({
      client,
      edits,
      ensureReady,
      review,
      history,
      specFor: modelSpec,
      models: () => readConfig().allowModelFallback ? readConfig().models : readConfig().models.slice(0, 1),
      run: (start) => withFallback({
        start,
        chain: readConfig().allowModelFallback ? readConfig().models : readConfig().models.slice(0, 1),
        // Retries and switches go to the status bar and the log; only a final failure is a pop-up.
        onNotice: (notice) => {
          log.appendLine(`${notice.title}: ${notice.detail}`);
          if (notice.level === 'error') void vscode.window.showErrorMessage(`Anvil: ${notice.title}. ${notice.detail}`);
          else vscode.window.setStatusBarMessage(`$(sync~spin) Anvil: ${notice.title.toLowerCase()} (${notice.detail.split('.')[0]})`, 8000);
        },
      }),
      relPath: (abs) => {
        const r = rel(abs);
        return r.startsWith('..') || path.isAbsolute(r) ? undefined : r;
      },
    }),
    vscode.window.registerWebviewViewProvider(ChatView.id, view, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerTreeDataProvider(ChangesView.id, new ChangesView(drafts, (p) => workspace.resolve(p))),
    vscode.commands.registerCommand('anvil.newChat', () => canSwitch() ? controller.newChat() : undefined),
    vscode.commands.registerCommand('anvil.stop', stopAll),
    vscode.commands.registerCommand('anvil.focus', () => vscode.commands.executeCommand('anvil.chat.focus')),
    vscode.commands.registerCommand('anvil.inlineHistory', () => showInlineHistory(history, client, root)),
    vscode.commands.registerCommand('anvil.history', openHistory),
  );
  void ensureReady().catch(() => undefined); // warm up; errors surface on first send
  return { drafts, review, controller };
}

export function deactivate(): void {}

/** Every command executes host code and requires an explicit, one-use approval. */
async function approveCommand(argsJson: string, ask: () => Promise<boolean>): Promise<Decision> {
  let command = '';
  try {
    command = String((JSON.parse(argsJson) as { command?: unknown }).command ?? '');
  } catch {
    return { status: 'deny', reason: 'Error: arguments are not valid JSON.' };
  }
  if (!command.trim()) return { status: 'deny', reason: 'Error: `command` is required.' };
  return (await ask()) ? { status: 'allow' } : { status: 'deny', reason: 'The user skipped this command.' };
}

/** Loads the last code graph at once, then rebuilds it in the background (output outside the workspace). */
async function startGraph(context: vscode.ExtensionContext, engine: ContextEngine, root: string, log: vscode.OutputChannel): Promise<void> {
  const outDir = vscode.Uri.joinPath(context.globalStorageUri, 'graphify', hashPath(root)).fsPath;
  const cached = loadGraph(`${outDir}/graph.json`);
  if (cached) engine.setGraph(cached);
  const configured = readConfig().graphifyCommand;
  // A bare name is looked up on PATH; a path is relative to the workspace.
  const command = /[\\/]/.test(configured) ? path.resolve(root, configured) : configured;
  const { graph, message } = await buildGraph({ root, outDir, command });
  if (graph) engine.setGraph(graph);
  log.appendLine(message);
}

/** FNV-1a: a short, stable folder name per workspace. */
function hashPath(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}
