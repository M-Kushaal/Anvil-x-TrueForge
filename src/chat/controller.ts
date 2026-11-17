// Owns one chat: its TrueForge session, the timeline state, and the running turn.
import { randomUUID } from 'node:crypto';
import type { ChatState, ContextView, FileChange, PlanStep, TimelineItem, Verification } from '../shared/protocol';
import { applyEvent, initialState } from '../forge/timeline';
import type { ApprovalRequest, Decision, ForgeClient, TurnOutcome } from '../forge/client';
import { buildSpec } from '../forge/agentSpec';
import { classify, describeStep, nextStep, type Classified } from '../forge/resilience';
import { plural } from '../shared/text';

export interface ChatDeps {
  initialChangeSetId?: string;
  onChangeSet?: (id: string, title: string) => void;
  onStop?: () => void;
  client: ForgeClient;
  models: () => string[];
  post: (state: ChatState) => void;
  onApproval: (request: ApprovalRequest) => Promise<Decision>;
  /** Makes sure the MCP connector is registered; throws a readable message if TrueForge is down. */
  ensureReady: () => Promise<void>;
  /** The context pack for a request: text appended to the message, and its view for the timeline. */
  contextFor?: (text: string) => Promise<{ text: string; view: ContextView }>;
  /** Spec settings per model: `config` overrides (e.g. compaction) and lean mode for small-limit models. */
  specFor?: (model: string) => { config?: Record<string, unknown>; lean?: boolean; connector?: string };
  /** Called after every turn, e.g. to save the chat so it can be reopened later. */
  onTurnEnd?: (sessionId: string, state: ChatState) => void;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

type Input = Array<{ type: 'user.message'; content: string }>;
type Notice = Omit<Extract<TimelineItem, { kind: 'notice' }>, 'kind' | 'id'>;

const CONTINUE = 'Continue the task from where you stopped. Edits you already staged are still staged; do not redo them.';
const MAX_PLAN_NUDGES = 3;
const MAX_FRESH_SESSIONS = 2;
const FRAME_MS = 33; // batch streamed updates to ~30 fps so the webview never floods

export class ChatController {
  private state: ChatState;
  private sessionId: string | undefined;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private seq = 0;
  private turns = 0;
  /** Stop can arrive before the session exists; remember it so the turn never starts. */
  private stopRequested = false;
  /** Identifies the current request; New chat and resume bump it so a stale stream is ignored. */
  private runId = 0;
  /** Wakes a retry wait early (Stop, New chat). */
  private wake: (() => void) | undefined;
  /** The user denied a command in this request: do not nudge the agent to carry on regardless. */
  private userDeclined = false;
  /** Why this request moved off the primary model, for one quiet note when it ends. */
  private switchNote: string | undefined;
  /** Index into the model chain the session currently uses (a fallback sticks until New chat). */
  private modelIndex = 0;

  constructor(private readonly deps: ChatDeps) {
    this.state = { ...initialState(deps.models()[0] ?? 'no model configured'), changeSetId: deps.initialChangeSetId ?? randomUUID() };
  }

  get snapshot(): ChatState {
    return this.state;
  }

  get currentSession(): string | undefined {
    return this.sessionId;
  }

  async send(text: string): Promise<void> {
    const prompt = text.trim();
    if (!prompt || this.state.running) return;
    const model = this.deps.models()[this.modelIndex] ?? this.deps.models()[0] ?? '';
    this.update({
      title: this.state.items.length === 0 ? titleFrom(prompt) : this.state.title,
      items: [...this.state.items, { kind: 'user', id: this.nextId('u'), text: prompt }],
      running: true,
      startedAt: Date.now(),
      model,
    });
    this.flushNow();
    this.stopRequested = false;
    this.userDeclined = false;
    this.switchNote = undefined;
    this.turns++;
    const run = ++this.runId;

    let outcome: TurnOutcome;
    let reported = false;
    try {
      await this.deps.ensureReady();
      if (this.stale(run)) { if (run === this.runId) this.finish({ status: 'cancelled' }, false); return; }
      const chain = this.deps.models();
      this.modelIndex = Math.min(this.modelIndex, Math.max(chain.length - 1, 0));
      if (!this.sessionId) {
        const created = await this.deps.client.createSession(this.spec(chain[this.modelIndex] ?? model));
        if (this.stale(run)) {
          void this.deps.client.cancel(created);
          if (run === this.runId) this.finish({ status: 'cancelled' }, false);
          return;
        }
        this.sessionId = created;
      }
      const context = this.deps.contextFor && wantsContext(prompt) ? await this.deps.contextFor(prompt).catch(() => undefined) : undefined;
      if (run !== this.runId) return; // replaced by New chat or a resumed chat meanwhile
      if (context) this.addItem({ kind: 'context', id: this.nextId('c'), context: context.view });
      const request = context ? `${prompt}\n\n${context.text}` : prompt;
      ({ outcome, reported } = await this.runWithRecovery(request, chain, run));
    } catch (error) {
      outcome = { status: 'error', message: error instanceof Error ? error.message : String(error) };
    }
    if (run === this.runId) this.finish(outcome, reported);
  }

  stop(): void {
    this.deps.onStop?.();
    if (!this.state.running) return;
    this.stopRequested = true;
    this.wake?.();
    if (this.sessionId) void this.deps.client.cancel(this.sessionId);
  }

  newChat(): void {
    this.stop();
    this.runId++;
    this.sessionId = undefined;
    this.modelIndex = 0;
    this.state = { ...initialState(this.deps.models()[0] ?? ''), changes: [], changeSetId: randomUUID(), connection: this.state.connection };
    this.deps.onChangeSet?.(this.state.changeSetId!, this.state.title);
    this.flushNow();
  }

  /** Reopens a saved chat: its timeline comes back and new messages continue its TrueForge session. */
  resume(chat: { sessionId: string; title: string; items: TimelineItem[]; changeSetId?: string }): void {
    this.stop();
    this.runId++;
    this.sessionId = chat.sessionId;
    this.modelIndex = 0;
    this.turns = chat.items.filter((i) => i.kind === 'user').length;
    // Keep new row ids clear of the restored ones (u3, n12, c4, plan2...).
    const used = chat.items.map((i) => Number(/^[a-z]{1,4}(\d+)$/.exec(i.id)?.[1] ?? 0));
    this.seq = Math.max(this.seq, ...used);
    this.state = { ...initialState(this.deps.models()[0] ?? ''), title: chat.title, items: chat.items, changes: [], changeSetId: chat.changeSetId ?? `session-${chat.sessionId}`, connection: this.state.connection };
    this.deps.onChangeSet?.(this.state.changeSetId!, chat.title);
    this.flushNow();
    // Back on the primary model; a session deleted in TrueForge is replaced on the next message.
    const model = this.deps.models()[0];
    if (model) {
      this.deps.client.setSpec(chat.sessionId, this.spec(model)).catch(() => {
        if (this.sessionId === chat.sessionId) this.sessionId = undefined;
      });
    }
  }

  /** Re-sends the current state (e.g. when the webview reloads). */
  refresh(): void {
    this.flushNow();
  }

  setVerification(verification: Verification | undefined): void { this.update({ verification }); this.flushNow(); }

  invalidateVerification(): void {
    if (this.state.verification && this.state.verification.status !== 'outdated') {
      this.setVerification({ ...this.state.verification, status: 'outdated' });
    }
  }

  setContextFiles(contextFiles: string[]): void { this.update({ contextFiles }); this.flushNow(); }
  setContextExcluded(contextExcluded: string[]): void { this.update({ contextExcluded }); this.flushNow(); }
  setCheckpointAvailable(checkpointAvailable: boolean): void { this.update({ checkpointAvailable }); this.flushNow(); }

  recoverChangeSet(id: string, title: string): void {
    this.newChat();
    this.state = { ...this.state, changeSetId: id, title };
    this.deps.onChangeSet?.(id, title);
    this.flushNow();
  }

  /** The agent published or updated its plan: one Plan card per turn, updated in place. */
  setPlan(steps: PlanStep[]): void {
    const id = `plan${this.turns}`;
    const item: TimelineItem = { kind: 'plan', id, steps };
    const exists = this.state.items.some((i) => i.kind === 'plan' && i.id === id);
    this.update({ items: exists ? this.state.items.map((i) => (i.kind === 'plan' && i.id === id ? item : i)) : [...this.state.items, item] });
    this.scheduleFlush();
  }

  /** The user decided on a waiting tool: show it as running until its result arrives. */
  markTool(id: string, status: 'running' | 'stopped'): void {
    this.update({ items: this.state.items.map((i) => (i.kind === 'tool' && i.id === id ? { ...i, status } : i)) });
    this.flushNow();
  }

  /** TrueForge became reachable, or stopped being. */
  setConnection(connection: { ok: boolean; message?: string }): void {
    this.update({ connection });
    this.flushNow();
  }

  /** Pending changes changed (staged, kept or undone). */
  setChanges(changes: FileChange[]): void {
    this.update({ changes });
    this.scheduleFlush();
  }

  /**
   * Runs the request to the end. On a model failure: retry, switch model in place, or start a fresh
   * session; when the agent stops with its plan unfinished, ask it to continue.
   */
  private async runWithRecovery(request: string, chain: string[], run: number): Promise<{ outcome: TurnOutcome; reported: boolean }> {
    const now = this.deps.now ?? Date.now;
    const readyAt: Record<number, number> = {}; // chain index → when its rate limit ends
    let input = message(request);
    let retries = 0;
    let lastKind = '';
    let nudges = 0;
    let freshSessions = 0;
    let history = false; // the session holds work from this request (a fresh one can shed it)

    const cancelled = { outcome: { status: 'cancelled' as const }, reported: false };
    for (;;) {
      if (this.stale(run)) return cancelled;
      const { outcome, produced } = await this.runOnce(input, run);
      if (run !== this.runId) return cancelled;
      history ||= produced;

      if (outcome.status === 'done' && !this.stopRequested && !this.userDeclined && nudges < MAX_PLAN_NUDGES && this.unfinishedPlan().length) {
        // The agent stopped with its own plan unfinished (small models do this after a compaction).
        nudges++;
        input = message(`${CONTINUE} Unfinished steps of your plan: ${this.unfinishedPlan().join('; ')}.`);
        continue;
      }
      if (outcome.status !== 'error') return { outcome, reported: false };

      const error = classify(outcome.message);
      if (error.kind === 'too_large' && history && freshSessions < MAX_FRESH_SESSIONS) {
        freshSessions++;
        history = false;
        input = message(await this.freshSession(request, chain, error, run));
        if (this.stale(run)) return cancelled;
        continue;
      }

      // Each kind of failure gets its own retry budget, renewed whenever the turn made progress.
      if (error.kind !== lastKind || produced) retries = 0;
      lastKind = error.kind;
      if (error.kind === 'rate_limit') readyAt[this.modelIndex] = now() + (error.retryAfterMs ?? 10_000);
      const cooldowns = Object.fromEntries(Object.entries(readyAt).map(([i, t]) => [i, t - now()]));
      const step = nextStep({ chain, index: this.modelIndex, retries, error, cooldowns });
      const notice = describeStep({ chain, index: this.modelIndex, error, step });
      if (step.action === 'give_up') {
        this.addNotice(notice);
        return { outcome, reported: true };
      }
      // Retries and switches are passing states: one line in the working bar, not a card each.
      this.update({ activity: notice.detail });
      this.flushNow();
      if (step.action === 'switch') {
        this.switchNote = `${chain[this.modelIndex]}: ${error.summary}`;
        this.addNotice({ level: 'info', title: `Switching to ${chain[step.to]}`, detail: this.switchNote });
      }

      if (step.action === 'retry') {
        retries++;
        await this.wait(step.delayMs);
      } else {
        // Hops between accounts of a rate-limited model share one budget; any other switch starts afresh.
        retries = error.kind === 'rate_limit' ? retries + 1 : 0;
        await this.wait(step.delayMs ?? 0);
        if (this.stale(run)) return cancelled;
        this.modelIndex = step.to;
        await this.deps.client.setSpec(this.sessionId!, this.spec(chain[step.to]!));
        if (this.stale(run)) return cancelled;
        this.update({ model: chain[step.to]! });
      }
      // A turn that got partway keeps its history in the session; just ask it to continue.
      if (produced) input = message(CONTINUE);
    }
  }

  /** One TrueForge turn, streamed into the timeline (events of a replaced request are dropped). */
  private async runOnce(input: Input, run: number): Promise<{ outcome: TurnOutcome; produced: boolean }> {
    let produced = false;
    const outcome = await this.deps.client.runTurn({
      sessionId: this.sessionId!,
      input,
      handlers: {
        onEvent: (event) => {
          if (run !== this.runId) return;
          if (event.type === 'model.message' || event.type === 'tool.response') produced = true;
          // The model is answering again: the "retrying…" line no longer applies.
          if (event.type === 'model.message' && this.state.activity) this.state = { ...this.state, activity: undefined };
          this.state = applyEvent(this.state, event);
          this.scheduleFlush();
        },
        onApproval: async (request) => {
          if (this.stale(run)) return { status: 'deny', reason: 'This task was stopped or replaced.' };
          const decision = await this.deps.onApproval(request);
          if (this.stale(run)) return { status: 'deny', reason: 'This task was stopped or replaced.' };
          if (decision.status === 'deny' && request.name === 'run_command') this.userDeclined = true;
          return decision;
        },
      },
      shouldStop: () => this.stale(run),
    });
    return { outcome, produced };
  }

  /** The request was stopped, or replaced by New chat or a resumed chat. */
  private stale(run: number): boolean {
    return this.stopRequested || run !== this.runId;
  }

  /** A retry wait that Stop and New chat cut short. */
  private wait(ms: number): Promise<void> {
    const sleep = this.deps.sleep ?? ((t: number) => new Promise<void>((r) => setTimeout(r, t)));
    return Promise.race([sleep(ms), new Promise<void>((r) => { this.wake = r; })]).finally(() => { this.wake = undefined; });
  }

  /**
   * The session's history outgrew the model's request limit (TrueForge compacts on the previous call's
   * size, so one large tool result can overshoot). Starts a new session and returns the message that
   * carries the task, what is already staged and the unfinished plan.
   */
  private async freshSession(request: string, chain: string[], error: Classified, run: number): Promise<string> {
    const model = chain[this.modelIndex]!;
    const created = await this.deps.client.createSession(this.spec(model));
    if (this.stale(run)) { void this.deps.client.cancel(created); return ''; }
    this.sessionId = created;
    const files = this.state.changes.length;
    this.update({ activity: `${model}: ${error.summary}. Continuing in a new TrueForge session with the task, the plan and ${plural(files, 'pending file')}.` });
    this.flushNow();
    const staged = this.state.changes.map((c) => `${c.path} (+${c.added} −${c.removed})`).join(', ') || 'none';
    // Earlier requests in this chat, so the new session knows what the conversation was about.
    const asked = this.state.items.flatMap((i) => (i.kind === 'user' ? [i.text] : [])).slice(0, -1).slice(-5);
    return [
      request,
      '',
      ...(asked.length ? ['Earlier in this chat the user asked:', ...asked.map((t) => `- ${t.slice(0, 200)}`), ''] : []),
      'Progress so far (the previous session ran out of room):',
      `- Already staged, do not redo: ${staged}`,
      `- Plan steps not done yet: ${this.unfinishedPlan().join('; ') || 'not recorded'}`,
      'Do the remaining steps only. Call update_plan first with the remaining steps.',
    ].join('\n');
  }

  /** Titles of this turn's plan steps that are not done. */
  private unfinishedPlan(): string[] {
    const plan = this.state.items.find((i) => i.kind === 'plan' && i.id === `plan${this.turns}`);
    return plan?.kind === 'plan' ? plan.steps.filter((s) => s.status !== 'done').map((s) => s.title) : [];
  }

  private spec(model: string): Record<string, unknown> {
    return buildSpec({ model, ...this.deps.specFor?.(model) });
  }

  private finish(outcome: TurnOutcome, reported: boolean): void {
    const ms = Date.now() - (this.state.startedAt ?? Date.now());
    const pending = this.state.changes.reduce((n, c) => n + c.hunks, 0);
    const notice = reported ? undefined : noticeFor(outcome, pending);
    const note: Notice | undefined = this.switchNote && outcome.status === 'done'
      ? { level: 'info', title: `Answered by ${this.state.model}`, detail: this.switchNote }
      : undefined;
    for (const n of [note, notice]) if (n) this.state = { ...this.state, items: [...this.state.items, { kind: 'notice', id: this.nextId('n'), ...n }] };
    // Rows the turn never finished (a stopped command, an approval left open) must not look live.
    const settled = this.state.items.map((i) => ((i.kind === 'tool' || i.kind === 'thread') && (i.status === 'running' || i.status === 'waiting') ? { ...i, status: 'stopped' as const } : i));
    this.update({ items: settled, running: false, activity: undefined, lastTurn: { tokens: outcome.tokens ?? 0, ms } });
    this.flushNow();
    if (this.sessionId) this.deps.onTurnEnd?.(this.sessionId, this.state);
  }

  private addNotice(notice: Notice): void {
    this.addItem({ kind: 'notice', id: this.nextId('n'), ...notice });
  }

  private addItem(item: TimelineItem): void {
    this.update({ items: [...this.state.items, item] });
    this.flushNow();
  }

  private update(patch: Partial<ChatState>): void {
    this.state = { ...this.state, ...patch };
  }

  private scheduleFlush(): void {
    this.flushTimer ??= setTimeout(() => this.flushNow(), FRAME_MS);
  }

  private flushNow(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.deps.post(this.state);
  }

  private nextId(prefix: string): string {
    return `${prefix}${++this.seq}`;
  }
}

const message = (content: string): Input => [{ type: 'user.message', content }];

/** The closing notice for a turn that did not finish normally. */
function noticeFor(outcome: TurnOutcome, pending: number): Notice | undefined {
  if (outcome.status === 'done') return undefined;
  if (outcome.status === 'cancelled') return { level: 'info', title: 'Stopped', ...(pending ? { detail: `${plural(pending, 'change')} waiting for review.` } : {}) };
  const reason = outcome.message?.replace(/^\[(Model|MCP) Error\]\s*/, '') || 'TrueForge ended the turn without a reason';
  return { level: 'error', title: 'Couldn\'t finish', detail: `${reason.replace(/\.?$/, '.')} ${pending ? `${plural(pending, 'change')} still waiting for review.` : 'Review any changes you already kept.'}` };
}

/** Greetings and one-word replies get no context pack: retrieval would only add unrelated files. */
function wantsContext(prompt: string): boolean {
  if (/(^|\s)@\S/.test(prompt)) return true;
  if (/^(hi|hey|hello|yo|thanks?|thank you|ok(ay)?|cool|nice|great|sure|yes|no)[\s!.?]*$/i.test(prompt)) return false;
  return prompt.split(/\s+/).length >= 2;
}

function titleFrom(prompt: string): string {
  const firstLine = prompt.split('\n')[0] ?? prompt;
  return firstLine.length > 48 ? `${firstLine.slice(0, 47)}…` : firstLine;
}
