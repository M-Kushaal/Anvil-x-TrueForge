// Thin wrapper over the TrueForge SDK: sessions, one streamed turn, in-turn approvals, cancel.
import { TrueForge, isEventDelta, mergeEventDelta } from '@truefoundry/trueforge-sdk';
import { describeCall, type ForgeEvent } from './timeline';

export interface ApprovalRequest {
  toolCallId: string;
  threadId: string;
  name: string;
  args: string;
}
export type Decision = { status: 'allow' } | { status: 'deny'; reason: string };

export interface TurnOutcome {
  status: 'done' | 'error' | 'cancelled';
  message?: string;
  tokens?: number;
  retryable?: false;
}

export interface TurnHandlers {
  /** Every event, with streamed deltas already merged into their base message. */
  onEvent(event: ForgeEvent): void;
  onAbnormalExit?(): void;
  onQuestion?(request: ApprovalRequest): Promise<string>;
  /** Called for each gated tool call; the turn stays paused until it resolves. */
  onApproval(request: ApprovalRequest): Promise<Decision>;
}

/** The SDK surface Anvil uses; tests substitute a fake. */
export interface ForgeApi {
  sessions: {
    create(request: object): Promise<{ data: { id: string } }>;
    createTurnStream(sessionId: string, request: object, options?: { abortSignal: AbortSignal }): Promise<{ withMetadata(): AsyncIterable<{ data: unknown }> }>;
    createTurnEvents(sessionId: string, turnId: string, request: object, options?: { timeoutInSeconds: number; maxRetries: number }): Promise<unknown>;
    cancel(sessionId: string, options?: { timeoutInSeconds: number; maxRetries: number }): Promise<unknown>;
    update(sessionId: string, request: object): Promise<unknown>;
  };
}

export const CONNECTOR_NAME = 'anvil-editor';

export class ForgeClient {
  private readonly unconfirmed = new Set<string>();
  constructor(private readonly api: ForgeApi, readonly baseUrl: string, private readonly onApprovalFailure?: () => void) {}

  static connect(baseUrl: string, onApprovalFailure?: () => void): { client: ForgeClient; sdk: TrueForge } {
    const sdk = new TrueForge({ baseUrl, timeoutInSeconds: 900 });
    return { client: new ForgeClient(sdk as unknown as ForgeApi, baseUrl, onApprovalFailure), sdk };
  }

  async createSession(spec: object): Promise<string> {
    const { data } = await this.api.sessions.create({ agent: { spec } });
    return data.id;
  }

  /** Swaps the session's agent spec (e.g. a fallback model); the conversation is kept. */
  async setSpec(sessionId: string, spec: object): Promise<void> {
    await this.api.sessions.update(sessionId, { agent: { spec } });
  }

  cancel(sessionId: string): Promise<boolean> {
    return this.api.sessions.cancel(sessionId, { timeoutInSeconds: 5, maxRetries: 0 }).then(
      () => { this.unconfirmed.delete(sessionId); return true; },
      () => { this.unconfirmed.add(sessionId); return false; },
    );
  }

  sessionUrl(sessionId: string): string {
    return `${this.baseUrl.replace(/\/+$/, '')}/sessions/${sessionId}`;
  }

  async runTurn({ sessionId, input, handlers, shouldStop, signal }: {
    sessionId: string; input: object[]; handlers: TurnHandlers;
    /** Checked once the turn exists, so a Stop pressed while it was starting still cancels it. */
    shouldStop?: () => boolean;
    signal?: AbortSignal;
  }): Promise<TurnOutcome> {
    if (this.unconfirmed.has(sessionId) && !await this.cancel(sessionId)) {
      return { status: 'error', message: 'TrueForge did not confirm cancellation of the previous turn.', retryable: false };
    }
    const events = new Map<string, ForgeEvent>();
    let turnId: string | undefined;
    let outcome: TurnOutcome | undefined;
    let failure: string | undefined;
    let closed = false;
    const streamAbort = new AbortController();
    const active = () => !closed && !outcome && !failure && !signal?.aborted && !shouldStop?.();
    let cancellation: Promise<boolean> | undefined;
    const stopStream = () => {
      cancellation ??= this.cancel(sessionId);
      streamAbort.abort();
    };
    if (signal?.aborted) return { status: 'cancelled' };
    signal?.addEventListener('abort', stopStream, { once: true });
    try {
      const stream = await this.api.sessions.createTurnStream(sessionId, { input }, { abortSignal: streamAbort.signal });
      for await (const { data } of stream.withMetadata()) {
        const event = data as ForgeEvent & { turnId?: string };
        if (isEventDelta(event as never)) {
          const base = events.get(event.id);
          if (!base) continue;
          mergeEventDelta(base as never, event as never);
          handlers.onEvent({ ...base });
          continue;
        }
        events.set(event.id, event);
        if (event.type === 'turn.created') {
          turnId = event.turnId;
          if (shouldStop?.()) stopStream();
        }
        if ((event.type === 'tool.approval_required' || event.type === 'tool.response_required') && turnId) {
          void this.resolveApprovals({ sessionId, turnId, event, events, handlers, active }).catch((error: unknown) => {
            if (!active()) return;
            failure = `Could not send tool approval to TrueForge: ${String(error)}`;
            stopStream();
          });
        }
        handlers.onEvent(event);
        if (event.type === 'turn.done') {
          outcome = toOutcome(event);
          break;
        }
      }
    } catch (error) {
      failure ??= error instanceof Error ? error.message : String(error);
    } finally {
      closed = true;
      signal?.removeEventListener('abort', stopStream);
    }
    if (signal?.aborted || shouldStop?.()) {
      await cancellation;
      return { status: 'cancelled' };
    }
    if (outcome && !failure) return outcome;
    const cleanup = handlers.onAbnormalExit ?? this.onApprovalFailure;
    cleanup?.();
    const confirmed = await (cancellation ?? this.cancel(sessionId));
    const message = failure ?? 'The stream ended without a result.';
    if (!confirmed) return { status: 'error', message: `${message} TrueForge did not confirm cancellation.`, retryable: false };
    return cancellation || !turnId ? { status: 'error', message, retryable: false } : { status: 'error', message };
  }

  /** Each decision is posted into the paused turn as soon as the user makes it. */
  private async resolveApprovals({ sessionId, turnId, event, events, handlers, active }: {
    sessionId: string; turnId: string; event: ForgeEvent; events: Map<string, ForgeEvent>; handlers: TurnHandlers; active: () => boolean;
  }): Promise<void> {
    const refs = Array.isArray(event.toolCalls) ? (event.toolCalls as Array<{ id: string; sourceEventId: string }>) : [];
    const threadId = event.threadId ?? 'main';
    await Promise.all(refs.map(async (ref) => {
      const source = events.get(ref.sourceEventId);
      const call = (Array.isArray(source?.toolCalls) ? source.toolCalls : []).find((c: { id: string }) => c.id === ref.id);
      const { name, args } = call ? describeCall(call) : { name: 'tool', args: '{}' };
      if (event.type === 'tool.response_required') {
        const content = handlers.onQuestion ? await handlers.onQuestion({ toolCallId: ref.id, threadId, name, args }) : 'The client cannot answer this question.';
        if (!active()) return;
        await this.api.sessions.createTurnEvents(sessionId, turnId, { events: [{ type: 'user.tool_response', threadId, toolCallId: ref.id, content }] }, { timeoutInSeconds: 10, maxRetries: 0 });
        return;
      }
      const decision = await handlers.onApproval({ toolCallId: ref.id, threadId, name, args })
        .catch((): Decision => ({ status: 'deny', reason: 'Review was closed.' }));
      if (!active()) return;
      await this.api.sessions.createTurnEvents(sessionId, turnId, {
        events: [{ type: 'user.tool_approval', threadId, toolCallId: ref.id, approval: decision }],
      }, { timeoutInSeconds: 10, maxRetries: 0 });
    }));
  }
}

function toOutcome(event: ForgeEvent): TurnOutcome {
  const state = event.state ?? {};
  const status = state.status === 'done' || state.status === 'cancelled' ? state.status : 'error';
  const message = state.message ?? state.reason;
  const tokens = state.metrics?.totalTokens;
  return { status, ...(message ? { message } : {}), ...(tokens !== undefined ? { tokens } : {}) };
}
