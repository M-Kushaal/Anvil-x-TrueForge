// Hosts the chat webview and relays messages between it and the controller.
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { ChatState, FromWebview, ToWebview, SidebarHistory } from '../shared/protocol';

export class ChatView implements vscode.WebviewViewProvider {
  static readonly id = 'anvil.chat';
  private view: vscode.WebviewView | undefined;
  private last: ChatState | undefined;
  private sidebar: SidebarHistory = { mode: 'chat', chats: [], inlineEdits: [] };

  setSidebar(sidebar: SidebarHistory): void {
    this.sidebar = sidebar;
    if (this.last) this.post(this.last);
  }

  constructor(private readonly extensionUri: vscode.Uri, private readonly onMessage: (message: FromWebview) => void) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const dist = vscode.Uri.joinPath(this.extensionUri, 'dist');
    view.webview.options = { enableScripts: true, localResourceRoots: [dist] };
    view.webview.html = renderHtml(view.webview, dist);
    view.webview.onDidReceiveMessage((message: FromWebview) => {
      if (message.type === 'ready' && this.last) this.post(this.last);
      this.onMessage(message);
    });
  }

  post(state: ChatState): void {
    this.last = state;
    const message: ToWebview = { type: 'state', state: { ...state, sidebar: this.sidebar } };
    void this.view?.webview.postMessage(message);
  }
}

function renderHtml(webview: vscode.Webview, dist: vscode.Uri): string {
  const nonce = randomBytes(16).toString('hex');
  const asset = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(dist, name)).toString();
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
    `img-src ${webview.cspSource} data:`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="stylesheet" href="${asset('webview.css')}" />
  <title>Anvil</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${asset('webview.js')}"></script>
</body>
</html>`;
}
