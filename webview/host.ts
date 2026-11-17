// Bridge to the extension host. Falls back to a no-op outside VS Code (component tests).
import type { FromWebview } from '../src/shared/protocol';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const api = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : { postMessage: () => undefined };

export function send(message: FromWebview): void {
  api.postMessage(message);
}
