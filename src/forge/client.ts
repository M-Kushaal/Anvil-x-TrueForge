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
}

export interface TurnHandlers {
  /** Every event, with streamed deltas already merged into their base message. */
  onEvent(event: ForgeEvent): void;
  /** Called for each gated tool call; the turn stays paused until it resolves. */
  onApproval(request: ApprovalRequest): Promise<Decision>;
}

/** The SDK surface Anvil uses; tests substitute a fake. */
export interface ForgeApi {
  sessions: {
    create(request: object): Promise<{ data: { id: string } }>;
    createTurnStream(sessionId: string, request: object): Promise<{ withMetadata(): AsyncIterable<{ data: unknown }> }>;
    createTurnEvents(sessionId: string, turnId: string, request: object): Promise<unknown>;
    cancel(sessionId: string): Promise<unknown>;
    update(sessionId: string, request: object): Promise<unknown>;
  };
}

export const CONNECTOR_NAME = 'anvil-editor';

export class ForgeClient {
  constructor(private readonly api: ForgeApi, readonly baseUrl: string) {}

  static connect(baseUrl: string): { client: ForgeClient; sdk: TrueForge } {
    const sdk = new TrueForge({ baseUrl, timeoutInSeconds: 900 });
    return { client: new ForgeClient(sdk as unknown as ForgeApi, baseUrl), sdk };
  }

  async createSession(spec: object): Promise<string> {
    const { data } = await this.api.sessions.create({ agent: { spec } });
    return data.id;
  }

  /** Swaps the session's agent spec (e.g. a fallback model); the conversation is kept. */
  async setSpec(sessionId: string, spec: object): Promise<void> {
    await this.api.sessions.update(sessionId, { agent: { spec } });
  }

  cancel(sessionId: string): Promise<unknown> {
    return this.api.sessions.cancel(sessionId).catch(() => undefined);
  }

  sessionUrl(sessionId: string): string {
    return `${this.baseUrl.replace(/\/+$/, '')}/sessions/${sessionId}`;
  }

  async runTurn({ sessionId, input, handlers, shouldStop }: {
    sessionId: string; input: object[]; handlers: TurnHandlers;
    /** Checked once the turn exists, so a Stop pressed while it was starting still cancels it. */
    shouldStop?: () => boolean;
  }): Promise<TurnOutcome> {
    const events = new Map<string, ForgeEvent>();
    let turnId: string | undefined;
    let outcome: TurnOutcome | undefined;
    try {
      const stream = await this.api.sessions.createTurnStream(sessionId, { input });
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
          if (shouldStop?.()) void this.cancel(sessionId);
        }
        if (event.type === 'tool.approval_required' && turnId) {
          void this.resolveApprovals({ sessionId, turnId, event, events, handlers });
        }
        if (event.type === 'turn.done') outcome = toOutcome(event);
        handlers.onEvent(event);
      }
    } catch (error) {
      // The stream broke but the turn may still run on the server: cancel it so a retry never runs
      // alongside it.
      if (turnId && !outcome) void this.cancel(sessionId);
      return { status: 'error', message: error instanceof Error ? error.message : String(error) };
    }
    return outcome ?? { status: 'error', message: 'The stream ended without a result.' };
  }

  /** Each decision is posted into the paused turn as soon as the user makes it. */
  private async resolveApprovals({ sessionId, turnId, event, events, handlers }: {
    sessionId: string; turnId: string; event: ForgeEvent; events: Map<string, ForgeEvent>; handlers: TurnHandlers;
  }): Promise<void> {
    const refs = Array.isArray(event.toolCalls) ? (event.toolCalls as Array<{ id: string; sourceEventId: string }>) : [];
    const threadId = event.threadId ?? 'main';
    await Promise.all(refs.map(async (ref) => {
      const source = events.get(ref.sourceEventId);
      const call = (Array.isArray(source?.toolCalls) ? source.toolCalls : []).find((c: { id: string }) => c.id === ref.id);
      const { name, args } = call ? describeCall(call) : { name: 'tool', args: '{}' };
      const decision = await handlers.onApproval({ toolCallId: ref.id, threadId, name, args })
        .catch((): Decision => ({ status: 'deny', reason: 'Review was closed.' }));
      await this.api.sessions
        .createTurnEvents(sessionId, turnId, { events: [{ type: 'user.tool_approval', threadId, toolCallId: ref.id, approval: decision }] })
        .catch(() => undefined); // the turn may already be cancelled
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
