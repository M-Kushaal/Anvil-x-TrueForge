// Messages and view models shared by the extension host and the chat webview.

export type RowStatus = 'running' | 'waiting' | 'done' | 'error' | 'stopped';

export interface PlanStep {
  title: string;
  status: 'todo' | 'doing' | 'done';
}

export interface ContextView {
  used: number;
  budget: number;
  items: Array<{ kind: 'impl' | 'test' | 'docs' | 'mention' | 'related'; path: string; tokens: number; reasons: string[] }>;
  dropped: Array<{ path: string; reason: string }>;
  /** e.g. "Ranked by keywords and the code graph · 212 files" */
  source: string;
}

export type TimelineItem =
  | { kind: 'context'; id: string; context: ContextView }
  | { kind: 'plan'; id: string; steps: PlanStep[] }
  | { kind: 'user'; id: string; text: string }
  | { kind: 'text'; id: string; threadId: string; text: string }
  | { kind: 'tool'; id: string; threadId: string; name: string; args: string; status: RowStatus; summary?: string; output?: string }
  | { kind: 'thread'; id: string; title: string; status: RowStatus }
  | { kind: 'notice'; id: string; level: 'info' | 'warn' | 'error'; title: string; detail?: string };

export interface FileChange {
  path: string;
  added: number;
  removed: number;
  hunks: number;
  isNew: boolean;
}

export interface ChatState {
  changeSetId?: string;
  verification?: Verification;
  contextFiles?: string[];
  contextExcluded?: string[];
  checkpointAvailable?: boolean;
  title: string;
  items: TimelineItem[];
  running: boolean;
  startedAt?: number;
  model: string;
  /** Totals of the last finished turn. */
  lastTurn?: { tokens: number; ms: number };
  /** What the running turn is waiting on (a retry, a model switch); shown in the working bar only. */
  activity?: string;
  /** Whether TrueForge is reachable; known before the first message. */
  connection?: { ok: boolean; message?: string };
  /** Pending (staged, unwritten) changes across the workspace. */
  changes: FileChange[];
}

export interface Verification {
  command: string;
  code: number | null;
  output: string;
  status: 'passed' | 'failed' | 'cancelled' | 'timedOut' | 'outdated';
  at: number;
  snapshotId: string;
}

export type ToWebview = { type: 'state'; state: ChatState };

export type FromWebview =
  | { type: 'ready' }
  | { type: 'send'; text: string }
  | { type: 'stop' }
  | { type: 'newChat' }
  | { type: 'history' }
  | { type: 'openFile'; path: string; line?: number }
  | { type: 'reconnect' }
  | { type: 'settings' }
  | { type: 'selectModel' }
  | { type: 'attachContext' }
  | { type: 'removeContext'; path: string }
  | { type: 'pinContext'; path: string }
  | { type: 'excludeContext'; path: string }
  | { type: 'restoreContext'; path: string }
  | { type: 'checkpoint' }
  | { type: 'restoreCheckpoint' }
  | { type: 'recoverChanges' }
  | { type: 'approve'; id: string; allow: boolean }
  | { type: 'review'; path?: string }
  | { type: 'keepAll' }
  | { type: 'discardAll' };
