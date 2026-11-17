// Runs one inline edit through TrueForge: its own short session, only read_file + propose_edit,
// and an approval gate that adds the scope lock on top of normal edit validation.
import { buildSpec } from '../forge/agentSpec';
import type { ApprovalRequest, Decision, ForgeClient, TurnOutcome } from '../forge/client';
import { classify, describeStep, nextStep, type RecoveryNotice } from '../forge/resilience';
import { firstLine, type ForgeEvent } from '../forge/timeline';
import { isPendingSummary, validateEdit, type EditContext } from '../mcp/editTools';
import { inlineSession, newEntryId, type InlineHistory, type InlineStatus } from './history';
import { buildInlinePrompt, INLINE_INSTRUCTIONS, scopeViolation, type InlineRequest } from './prompt';

export interface InlineDeps {
  client: ForgeClient;
  edits: EditContext;
  ensureReady: () => Promise<void>;
  /** When set, edits share one TrueForge session and are listed in the history. */
  history?: InlineHistory;
  /** Per-model spec settings, as for chat (lean mode and compaction for small-limit models). */
  specFor?: (model: string) => { config?: Record<string, unknown>; lean?: boolean; connector?: string };
}

export interface InlineResult {
  outcome: TurnOutcome;
  /** Pending hunks for the file after the run (0 means nothing was proposed). */
  pending: number;
  sessionId?: string;
}

export interface InlineHandle {
  done: Promise<InlineResult>;
  cancel(): void;
}

/**
 * Retries or falls back across the model chain (same policy as chat). Each attempt is a new turn
 * (in the shared inline session when there is one); a failed attempt writes nothing.
 */
export function withFallback({ start, chain, onNotice, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }: {
  start: (model: string) => InlineHandle;
  chain: string[];
  onNotice: (notice: RecoveryNotice, model: string) => void;
  sleep?: (ms: number) => Promise<void>;
}): InlineHandle {
  let current: InlineHandle | undefined;
  let cancelled = false;
  const done = (async (): Promise<InlineResult> => {
    let index = 0;
    let retries = 0;
    let lastKind = '';
    for (;;) {
      current = start(chain[index] ?? '');
      const result = await current.done;
      if (cancelled || result.outcome.status !== 'error' || result.pending > 0) return result;
      const error = classify(result.outcome.message);
      if (error.kind !== lastKind) retries = 0;
      lastKind = error.kind;
      const step = nextStep({ chain, index, retries, error });
      onNotice(describeStep({ chain, index, error, step }), chain[step.action === 'switch' ? step.to : index] ?? '');
      if (step.action === 'give_up') return result;
      if (step.action === 'retry') {
        retries++;
        await sleep(step.delayMs);
      } else {
        retries = error.kind === 'rate_limit' ? retries + 1 : 0;
        await sleep(step.delayMs ?? 0);
        index = step.to;
      }
      if (cancelled) return { outcome: { status: 'cancelled' }, pending: result.pending };
    }
  })();
  return {
    done,
    cancel() {
      cancelled = true;
      current?.cancel();
    },
  };
}

export function startInlineEdit({ deps, request, model, onEvent }: {
  deps: InlineDeps;
  request: InlineRequest;
  model: string;
  onEvent?: (event: ForgeEvent) => void;
}): InlineHandle {
  let sessionId: string | undefined;
  let cancelled = false;
  const generation = deps.edits.generation?.();

  const onApproval = async ({ name, args }: ApprovalRequest): Promise<Decision> => {
    if (cancelled || generation !== deps.edits.generation?.()) return { status: 'deny', reason: 'This inline edit was cancelled.' };
    if (name !== 'propose_edit') return { status: 'deny', reason: 'Inline edits may only use propose_edit.' };
    const invalid = await validateEdit(deps.edits, name, args);
    if (cancelled || generation !== deps.edits.generation?.()) return { status: 'deny', reason: 'This inline edit was cancelled.' };
    if (invalid) return { status: 'deny', reason: invalid };
    const parsed = JSON.parse(args) as { path: string; search: string };
    const { search } = parsed;
    const path = deps.edits.normalize ? deps.edits.normalize(parsed.path) : parsed.path;
    if (path !== request.path) return { status: 'deny', reason: `Error: only ${request.path} may be edited.` };
    const text = deps.edits.drafts.view(path) ?? request.text;
    const outside = scopeViolation({ text, search, startLine: request.startLine, endLine: request.endLine });
    if (outside) return { status: 'deny', reason: outside };
    deps.edits.authorize?.(name, args);
    return { status: 'allow' };
  };

  const entryId = newEntryId();
  const run = (async (): Promise<InlineResult> => {
    const before = deps.edits.drafts.pending(request.path).length;
    try {
      await deps.ensureReady();
      await deps.history?.add({
        id: entryId, at: Date.now(), path: request.path, startLine: request.startLine, endLine: request.endLine,
        instruction: request.instruction, model, status: 'running',
      });
      const { config, ...modelSettings } = deps.specFor?.(model) ?? {};
      const spec = buildSpec({
        model,
        ...modelSettings,
        instructions: INLINE_INSTRUCTIONS,
        enableTools: ['read_file', 'propose_edit'],
        config: { ...config, dynamic_sub_agents: { enabled: false }, ask_user_questions: { enabled: false }, iteration_limit: 8 },
      });
      sessionId = deps.history ? await inlineSession(deps.client, deps.history, spec) : await deps.client.createSession(spec);
      if (cancelled) return { outcome: { status: 'cancelled' }, pending: before, sessionId };
      let staged = false;
      const id = sessionId;
      const outcome = await deps.client.runTurn({
        sessionId,
        input: [{ type: 'user.message', content: buildInlinePrompt(request) }],
        handlers: {
          onEvent: (e) => {
            onEvent?.(e);
            // The edit is staged: end the turn instead of spending a model call on a summary.
            if (!staged && e.type === 'tool.response' && isPendingSummary(firstLine(e.content))) {
              staged = true;
              void deps.client.cancel(id);
            }
          },
          onApproval,
        },
        shouldStop: () => cancelled,
      });
      const finished: TurnOutcome = staged && !cancelled ? { status: 'done', ...(outcome.tokens !== undefined ? { tokens: outcome.tokens } : {}) } : outcome;
      return { outcome: finished, pending: deps.edits.drafts.pending(request.path).length, sessionId };
    } catch (error) {
      return { outcome: { status: 'error', message: error instanceof Error ? error.message : String(error) }, pending: before, ...(sessionId ? { sessionId } : {}) };
    }
  })();
  const done = run.then(async (result) => {
    await deps.history?.finish(entryId, statusOf(result), result.outcome.message);
    // The shared session outgrew the model's request limit: the next attempt starts a new one.
    if (result.outcome.status === 'error' && classify(result.outcome.message).kind === 'too_large') await deps.history?.resetSession();
    return result;
  });

  return {
    done,
    cancel() {
      cancelled = true;
      if (sessionId) void deps.client.cancel(sessionId);
    },
  };
}

function statusOf({ outcome, pending }: InlineResult): InlineStatus {
  if (outcome.status === 'cancelled') return 'stopped';
  if (outcome.status === 'error') return 'failed';
  return pending > 0 ? 'staged' : 'no-change';
}
