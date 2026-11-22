// Activation and wiring only; behaviour lives in the modules it connects.
import * as vscode from 'vscode';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readConfig } from './config';
import { ChatController } from './chat/controller';
import { ChatHistory } from './chat/history';
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
import { withFallback } from './inline/run';
import { commandTools, killRunningCommands } from './mcp/commandTools';
import { contextTools } from './mcp/contextTools';
import { editTools, validateEdit, isPendingSummary, EDIT_TOOL_NAMES, type EditContext } from './mcp/editTools';
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
import { createWorkspace, isCommandSnapshotPath, isIndexablePath } from './workspace/workspace';

/** Internals exposed to the e2e tests (and nothing else). */
export interface AnvilApi {
  drafts: DraftStore;
  review: ReviewService;
  controller: ChatController;
}

let shutdown: (() => Promise<void>) | undefined;

export async function deactivate(): Promise<void> {
  await shutdown?.();
}

export async function activate(context: vscode.ExtensionContext): Promise<AnvilApi | undefined> {
  const launcherWorkspace = vscode.Uri.joinPath(context.extensionUri, '.cache', 'debug', 'flask.code-workspace');
  if (context.extensionMode === vscode.ExtensionMode.Development
    && vscode.workspace.workspaceFile?.fsPath === launcherWorkspace.fsPath) {
    const bytes = await vscode.workspace.fs.readFile(launcherWorkspace);
    const launch: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
    if (!launch || typeof launch !== 'object' || !('folders' in launch) || !Array.isArray(launch.folders)) {
      throw new Error('The fresh Flask launcher has no workspace folder. Run prepare:debug again.');
    }
    const target: unknown = launch.folders[0];
    if (!target || typeof target !== 'object' || !('path' in target) || typeof target.path !== 'string') {
      throw new Error('The fresh Flask workspace path is missing.');
    }
    const relative = path.relative(path.dirname(launcherWorkspace.fsPath), target.path);
    if (path.isAbsolute(relative) || !/^flask-[^/\\]+$/.test(relative)) {
      throw new Error('The fresh Flask workspace must be inside the debug directory.');
    }
    // Open the unique folder itself so VS Code uses a new workspace identity on each launch.
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target.path), { forceReuseWindow: true });
    return undefined;
  }
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return undefined; // Anvil works on an open folder
  const root = folder.uri.fsPath;
  const demoRoot = path.join(context.extensionUri.fsPath, '.cache', 'debug');
  const demoRelative = path.relative(demoRoot, root);
  const generatedDemo = context.extensionMode === vscode.ExtensionMode.Development
    && !path.isAbsolute(demoRelative) && /^flask-[^/\\]+$/.test(demoRelative);
  if (generatedDemo && context.workspaceState.get<string>('anvil.debugRoot') !== root) {
    for (const key of context.workspaceState.keys().filter((key) => key.startsWith('anvil.'))) {
      await context.workspaceState.update(key, undefined);
    }
    await context.workspaceState.update('anvil.debugRoot', root);
    // VS Code restores tabs by workspace-file identity, even when its folder was replaced.
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    void vscode.window.showInformationMessage(`Anvil opened a fresh Flask baseline: ${path.basename(root)}`);
  }

  const rel = (abs: string) => path.relative(root, abs).split(path.sep).join('/');
  const isWorkspacePath = (p: string) => Boolean(p) && p !== '..' && !p.startsWith('../') && !path.isAbsolute(p);
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
  let graphStarted = false;
  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  const reindex = (uri: vscode.Uri) => {
    const r = rel(uri.fsPath);
    if (!isWorkspacePath(r)) return;
    if (isIndexablePath(r)) engine.invalidate(r);
    if (isCommandSnapshotPath(r)) {
      workspaceRevision++;
      controller.invalidateVerification();
    }
  };
  watcher.onDidCreate((uri) => { workspace.invalidate(); reindex(uri); });
  watcher.onDidDelete((uri) => { workspace.invalidate(); reindex(uri); });
  watcher.onDidChange(reindex);
  const review = new ReviewService(workspace, drafts, (message) => void vscode.window.showInformationMessage(`Anvil: ${message}`));

  // TrueForge and the editor tools it calls over MCP.
  const questions = new Map<string, (answer: string) => void>();
  const revokeApprovals = () => {
    for (const resolve of questions.values()) resolve('The task was stopped.');
    questions.clear();
    permissions.revoke();
    editPermissions.revoke();
    for (const resolve of waiting.values()) resolve(false);
    waiting.clear();
  };
  const { client, sdk } = ForgeClient.connect(readConfig().serverUrl, revokeApprovals);
  const edits: EditContext = {
    generation: () => permissions.epoch,
    authorize: (name, args, onStaged) => editPermissions.grant(name, args, onStaged),
    drafts,
    realText: (p) => readReal(workspace, p),
    model: () => controller.snapshot.model,
    normalize: (p) => rel(workspace.resolve(p)),
  };
  const host = await startMcpServer({
    tools: () => [
      ...readTools(workspace),
      ...contextTools(engine),
      ...editTools(edits).map((tool) => ({ ...tool, run: async (args: unknown) => {
        const onStaged = editPermissions.take(tool.name, args);
        if (!onStaged) return 'Error: edit approval expired or was not granted. Request approval again.';
        const result = await tool.run(args);
        if (isPendingSummary(result.split('\n', 1)[0] ?? '')) onStaged();
        return result;
      } })),
      ...commandTools({
        ws: workspace, drafts,
        extraPath: () => readConfig().commandPath.map((p) => path.resolve(root, p)),
        snapshotId,
        snapshot: () => vscode.workspace.textDocuments.filter((d) => d.isDirty && d.uri.scheme === 'file')
          .map((doc) => ({ doc, path: rel(doc.uri.fsPath) }))
          .filter(({ path }) => isWorkspacePath(path) && isCommandSnapshotPath(path))
          .map(({ doc, path }) => ({ path, text: doc.getText().replace(/\r\n/g, '\n') })),
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
  let checking: Promise<void> | undefined;
  let availableModels: Set<string> | undefined;
  const connector = `${CONNECTOR_NAME}-${randomUUID()}`;
  const modelSpec = (model: string) => ({ ...specFor(model, readConfig()), connector });
  const serverUrl = readConfig().serverUrl;
  const configuredModels = () => {
    const config = readConfig();
    return config.allowModelFallback ? config.models : config.models.slice(0, 1);
  };
  const models = () => configuredModels().filter((model) => availableModels?.has(model) ?? true);
  const ensureReady = (): Promise<void> => (checking ??= (async () => {
    await (registered ??= registerConnector(sdk, host, connector, serverUrl));
    const { data } = await sdk.models.list({ timeoutInSeconds: 10 });
    availableModels = new Set(data.map((model) => model.name));
    if (!models().length) {
      const configured = configuredModels();
      throw new Error(configured.length
        ? `No configured model is registered (${configured.join(', ')}). Run npm run setup or choose a registered model.`
        : 'No model configured. Open Setup and add anvil.models.');
    }
    controller.setConnection({ ok: true });
  })().catch((error: unknown) => {
    registered = undefined;
    availableModels = undefined;
    controller.setConnection({ ok: false, message: error instanceof Error ? error.message : String(error) });
    throw error;
  }).finally(() => { checking = undefined; }));
  const unregisterConnector = async () => {
    await registered?.catch(() => undefined);
    await sdk.settings.mcpServers.delete(connector, { timeoutInSeconds: 3, maxRetries: 0 }).catch(() => undefined);
  };
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
      revokeApprovals();
      killRunningCommands();
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
    models,
    post: (state) => view?.post(state), // the view sends 'ready' and gets the latest state then
    onApproval,
    onQuestion: (request) => new Promise<string>((resolve) => { questions.set(request.toolCallId, resolve); }),
    ensureReady,
    specFor: modelSpec,
    onTurnEnd: (sessionId, state) => { changeSets.rename(state.title); void chats.save(sessionId, state).then(() => refreshSidebar()); },
    contextFor: async (prompt) => {
      const config = readConfig();
      if (!graphStarted) {
        graphStarted = true;
        void startGraph(context, engine, root, log).catch((error: unknown) => log.appendLine(String(error)));
      }
      const { contextBudget } = limitsFor(controller.snapshot.model || config.models[0] || '', config);
      const editor = editorMention(prompt);
      const mentions = [...pinnedContext, ...(editor ? [editor] : [])];
      const pack = await engine.pack(prompt, { budget: contextBudget, mentions, exclude: excludedContext, resolveExplicitMentions: true });
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
  let pendingInline: ((instruction?: string) => void) | undefined;
  const finishInlineInstruction = (text?: string) => {
    const resolve = pendingInline;
    pendingInline = undefined;
    controller.setInlineSelection(undefined);
    resolve?.(text);
  };
  const askInlineInstruction = async (selection: { file: string; start: number; end: number }) => {
    if (controller.snapshot.running) {
      void vscode.window.showInformationMessage('Stop the current chat run before starting an inline edit.');
      return undefined;
    }
    if (sidebarMode !== 'inline' || !inlineReturn) {
      inlineReturn = { mode: sidebarMode, changeSetId: controller.snapshot.changeSetId };
    }
    // Replacing a selection keeps the original return destination.
    finishInlineInstruction();
    const answer = new Promise<string | undefined>((resolve) => { pendingInline = resolve; });
    controller.setInlineSelection(selection);
    showSidebar('inline');
    void vscode.commands.executeCommand('anvil.chat.focus');
    return answer;
  };
  const canSwitch = () => {
    if (!drafts.isLocked()) return true;
    void vscode.window.showInformationMessage('Anvil: wait for the current Keep operation before switching tasks.');
    return false;
  };
  const selectModel = async () => {
    if (controller.snapshot.running || !canSwitch()) return;
    const config = readConfig();
    let available: string[];
    try {
      const { data } = await sdk.models.list({ timeoutInSeconds: 10 });
      available = data.map((model) => model.name);
      availableModels = new Set(available);
    } catch (error) {
      void vscode.window.showErrorMessage(`Anvil could not load registered models: ${String(error)}`);
      return;
    }
    const picked = await vscode.window.showQuickPick(
      [...new Set([...available, ...config.models])].map((name) => ({
        label: name,
        description: available.includes(name) ? 'Registered in TrueForge' : 'Run npm run setup to register this model',
      })),
      { title: 'Anvil model', placeHolder: 'Choose a registered model for this chat' },
    );
    if (!picked || controller.snapshot.running || !canSwitch()) return;
    if (!available.includes(picked.label)) {
      void vscode.window.showWarningMessage(`${picked.label} is configured but is not registered in TrueForge. Add the provider key to Anvil?s .env and run npm run setup.`);
      return;
    }
    // Workspace settings take precedence over global settings.
    await vscode.workspace.getConfiguration('anvil').update('models',
      [picked.label, ...config.models.filter((model) => model !== picked.label)],
      vscode.ConfigurationTarget.Workspace);
    try {
      await controller.selectModel(picked.label);
    } catch (error) {
      void vscode.window.showErrorMessage(`Anvil could not switch the current session model: ${String(error)}`);
    }
  };
  const rewind = async () => {
    if (controller.snapshot.running || drafts.isLocked()) {
      void vscode.window.showInformationMessage('Stop the current run and wait for Keep to finish before rewinding.');
      return;
    }
    const confirmed = await vscode.window.showWarningMessage(
      'Rewind every kept file change from the most recent edit request? This also works across chats and inline edits. The changes will be removed from the files.',
      { modal: true }, 'Rewind');
    if (confirmed === 'Rewind' && !controller.snapshot.running && !drafts.isLocked()) await review.rewindLastOperation();
  };
  const attachContext = async () => {
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
  let sidebarMode: 'chat' | 'history' | 'inline' = 'chat';
  let inlineReturn: { mode: 'chat' | 'history' | 'inline'; changeSetId: string | undefined } | undefined;
  let inlineReviewPath: string | undefined;
  const returnFromInline = () => {
    const destination = inlineReturn;
    inlineReturn = undefined;
    inlineReviewPath = undefined;
    if (destination && sidebarMode === 'inline' && destination.changeSetId === controller.snapshot.changeSetId) {
      showSidebar(destination.mode);
    }
  };
  const unsubscribeInlineReview = drafts.onChange(() => {
    if (inlineReviewPath && !drafts.pending(inlineReviewPath).length) returnFromInline();
  });
  context.subscriptions.push({ dispose: unsubscribeInlineReview });

  const refreshSidebar = () => view?.setSidebar({
    mode: sidebarMode,
    chats: chats.list().map(({ sessionId, title, at }) => ({ sessionId, title, at })),
    inlineEdits: history.entries(),
  });
  const showSidebar = (mode: typeof sidebarMode) => {
    sidebarMode = mode;
    refreshSidebar();
    void vscode.commands.executeCommand('anvil.chat.focus');
  };
  const openHistory = () => showSidebar('history');
  const removeChat = async (sessionId: string) => {
    const chat = chats.get(sessionId);
    if (!chat || controller.snapshot.running || !canSwitch()) return;
    const confirmed = await vscode.window.showWarningMessage(
      `Delete "${chat.title}" from Anvil history? Pending edits remain recoverable.`,
      { modal: true }, 'Delete');
    if (confirmed !== 'Delete' || controller.snapshot.running || !canSwitch()) return;
    if (controller.currentSession === sessionId) controller.newChat();
    await chats.remove(sessionId);
    refreshSidebar();
  };
  const unsubscribeHistory = history.onChange(refreshSidebar);
  context.subscriptions.push({ dispose: unsubscribeHistory });
  view = new ChatView(context.extensionUri, (message: FromWebview) => {
    switch (message.type) {
      case 'ready': refreshSidebar(); return controller.refresh();
      case 'sidebarBack': finishInlineInstruction(); return showSidebar('chat');
      case 'inlineHistory': return showSidebar('inline');
      case 'deleteInlineHistory': {
        const entry = history.entries().find((item) => item.id === message.id);
        if (!entry || entry.status === 'running') return;
        void vscode.window.showWarningMessage('Delete this entry from inline edit history?',
          { modal: true, detail: 'This removes the saved history entry only.' }, 'Delete').then(async (choice) => {
          if (choice === 'Delete') await history.remove(message.id);
        });
        return;
      }
      case 'deleteChat': return void removeChat(message.sessionId);
      case 'resumeChat': {
        const chat = chats.get(message.sessionId);
        if (chat && !controller.snapshot.running && canSwitch()) { finishInlineInstruction(); controller.resume(chat); showSidebar('chat'); }
        return;
      }
      case 'openSession': {
        const session = message.inline ? history.session() : controller.currentSession;
        if (session) void vscode.env.openExternal(vscode.Uri.parse(client.sessionUrl(session)));
        return;
      }
      case 'send': {
        const command = message.text.trim().toLowerCase();
        if (command === '/model') return void selectModel();
        if (command === '/rewind') return void rewind();
        if (command === '/usage') return controller.showUsage();
        review.beginOperation();
        return void controller.send(message.text);
      }
      case 'answerQuestion': {
        const resolve = questions.get(message.id);
        if (resolve && message.text.trim()) {
          questions.delete(message.id);
          controller.markTool(message.id, 'running');
          resolve(message.text.trim());
        }
        return;
      }
      case 'inlineInstruction': if (message.text.trim()) review.beginOperation(); return finishInlineInstruction(message.text.trim() || undefined);
      case 'cancelInlineInstruction': return finishInlineInstruction();
      case 'stop': finishInlineInstruction(); return stopAll();
      case 'newChat': finishInlineInstruction(); if (canSwitch()) { controller.newChat(); showSidebar('chat'); } return;
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
          .then((picked) => {
            if (!picked || !canSwitch()) return;
            const chat = chats.list().find((entry) => entry.changeSetId === picked.id);
            if (chat) controller.resume(chat);
            else controller.recoverChangeSet(picked.id, picked.label);
          });
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
    { dispose: () => { finishInlineInstruction(); stopAll(); void changeSets.flush(); } },
    review.register(),
    registerInlineEdit({
      askInstruction: askInlineInstruction,
      onFinished: (file, pending) => {
        if (pending > 0 && drafts.pending(file).length) inlineReviewPath = file;
        else returnFromInline();
      },
      client,
      edits,
      ensureReady: async () => {}, // the wrapper resolves the registered model chain before starting
      review,
      history,
      specFor: modelSpec,
      models,
      run: (start) => withFallback({
        start,
        chain: async () => { await ensureReady(); return models(); },
        // Retries and switches go to the status bar and the log; only a final failure is a pop-up.
        onNotice: (notice) => {
          log.appendLine(`${notice.title}: ${notice.detail}`);
          if (notice.level === 'error') void vscode.window.showErrorMessage(`Anvil: ${notice.title}. ${notice.detail}`);
          else vscode.window.setStatusBarMessage(`$(sync~spin) Anvil: ${notice.title.toLowerCase()} (${notice.detail.split('.')[0]})`, 8000);
        },
      }),
      relPath: (abs) => {
        const r = rel(abs);
        return isWorkspacePath(r) ? r : undefined;
      },
    }),
    vscode.window.registerWebviewViewProvider(ChatView.id, view, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerTreeDataProvider(ChangesView.id, new ChangesView(drafts, (p) => workspace.resolve(p))),
    vscode.commands.registerCommand('anvil.newChat', () => canSwitch() ? controller.newChat() : undefined),
    vscode.commands.registerCommand('anvil.stop', stopAll),
    vscode.commands.registerCommand('anvil.focus', () => vscode.commands.executeCommand('anvil.chat.focus')),
    vscode.commands.registerCommand('anvil.inlineHistory', () => showSidebar('inline')),
    vscode.commands.registerCommand('anvil.history', openHistory),
  );
  const activeChat = chats.list().find((chat) => chat.changeSetId === changeSets.activeId);
  if (activeChat) controller.resume(activeChat);
  shutdown = async () => {
    stopAll();
    await Promise.all([changeSets.flush(), unregisterConnector()]);
  };
  void ensureReady().catch(() => undefined); // warm up; errors surface on first send
  return { drafts, review, controller };
}

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
