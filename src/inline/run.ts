// Runs one inline edit through TrueForge: its own short session, only read_file + propose_edit,
// and an approval gate that adds the scope lock on top of normal edit validation.
import { setTimeout as delay } from 'node:timers/promises';
import { buildSpec } from '../forge/agentSpec';
import type { ApprovalRequest, Decision, ForgeClient, TurnOutcome } from '../forge/client';
import { classify, describeStep, MAX_TURN_ATTEMPTS, nextStep, type RecoveryNotice } from '../forge/resilience';
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
  /** Pending hunks for the file if this run staged an edit. */
  pending: number;
  sessionId?: string;
  /** Whether the turn emitted model or tool activity, matching chat recovery. */
  produced?: boolean;
}

export interface InlineHandle {
  done: Promise<InlineResult>;
  cancel(): void;
}

/**
 * Retries or falls back across the model chain (same policy as chat). Each attempt is a new turn
 * (in the shared inline session when there is one); a failed attempt writes nothing.
 */
export function withFallback({ start, chain, onNotice }: {
  start: (model: string) => InlineHandle;
  chain: string[] | (() => Promise<string[]>);
  onNotice: (notice: RecoveryNotice, model: string) => void;
}): InlineHandle {
  let current: InlineHandle | undefined;
  const abort = new AbortController();
  const stopped: InlineResult = { outcome: { status: 'cancelled' }, pending: 0 };
  const done = (async (): Promise<InlineResult> => {
    let models: string[];
    try {
      models = typeof chain === 'function' ? await chain() : chain;
    } catch (error) {
      return abort.signal.aborted ? stopped : { outcome: { status: 'error', message: String(error) }, pending: 0 };
    }
    if (abort.signal.aborted) return stopped;
    let index = 0;
    let retries = 0;
    let lastKind = '';
    const readyAt: Record<number, number> = {};
    for (let attempt = 1; ; attempt++) {
      current = start(models[index] ?? '');
      const result = await current.done;
      current = undefined;
      if (abort.signal.aborted) return { ...result, outcome: stopped.outcome };
      if (result.outcome.status !== 'error' || result.outcome.retryable === false || result.pending > 0) return result;
      if (attempt === MAX_TURN_ATTEMPTS) {
        onNotice({ level: 'error', title: 'Retry limit reached', detail: result.outcome.message ?? 'TrueForge did not finish the inline edit.' }, models[index] ?? '');
        return result;
      }
      const error = classify(result.outcome.message);
      if (error.kind !== lastKind || result.produced) retries = 0;
      lastKind = error.kind;
      if (error.kind === 'rate_limit') readyAt[index] = Date.now() + (error.retryAfterMs ?? 10_000);
      const cooldowns = Object.fromEntries(Object.entries(readyAt).map(([i, time]) => [i, time - Date.now()]));
      const step = nextStep({ chain: models, index, retries, error, cooldowns });
      onNotice(describeStep({ chain: models, index, error, step }), models[step.action === 'switch' ? step.to : index] ?? '');
      if (step.action === 'give_up') return result;
      try {
        await delay(step.delayMs ?? 0, undefined, { signal: abort.signal });
      } catch (error) {
        if (!abort.signal.aborted) throw error;
      }
      if (abort.signal.aborted) return stopped;
      retries = step.action === 'retry' || error.kind === 'rate_limit' ? retries + 1 : 0;
      if (step.action === 'switch') index = step.to;
    }
  })();
  return {
    done,
    cancel() {
      abort.abort();
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
  const turnAbort = new AbortController();
  let cancelled = false;
  const generation = deps.edits.generation?.();

  let produced = false;
  let staged = false;
  let responseSeen = false;
  const grants: Array<() => void> = [];
  const revoke = () => { for (const release of grants.splice(0)) release(); };
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
    const text = deps.edits.drafts.view(path) ?? await deps.edits.realText(path);
    if (cancelled || generation !== deps.edits.generation?.() || text !== request.text) {
      return { status: 'deny', reason: 'The selected document changed. Select the code again before editing.' };
    }
    const outside = scopeViolation({ text, search, startLine: request.startLine, endLine: request.endLine });
    if (outside) return { status: 'deny', reason: outside };
    const release = deps.edits.authorize?.(name, args, () => { staged = true; });
    if (release) grants.push(release);
    return { status: 'allow' };
  };

  const entryId = newEntryId();
  const run = (async (): Promise<InlineResult> => {
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
      if (cancelled) return { outcome: { status: 'cancelled' }, pending: 0, sessionId };
      const id = sessionId;
      const outcome = await deps.client.runTurn({
        sessionId,
        input: [{ type: 'user.message', content: buildInlinePrompt(request) }],
        handlers: {
          onEvent: (e) => {
            if (e.type === 'model.message' || e.type === 'tool.response') produced = true;
            onEvent?.(e);
            // The edit is staged: end the turn instead of spending a model call on a summary.
            if ((!deps.edits.authorize || staged) && !responseSeen && e.type === 'tool.response' && isPendingSummary(firstLine(e.content))) {
              responseSeen = true;
              staged ||= !deps.edits.authorize;
              void deps.client.cancel(id);
            }
          },
          onApproval,
          onAbnormalExit: revoke,
        },
        shouldStop: () => cancelled,
        signal: turnAbort.signal,
      });
      const finished: TurnOutcome = staged && !cancelled ? { status: 'done', ...(outcome.tokens !== undefined ? { tokens: outcome.tokens } : {}) } : outcome;
      return { outcome: finished, produced, pending: staged ? deps.edits.drafts.pending(request.path).length : 0, sessionId };
    } catch (error) {
      return { outcome: { status: 'error', message: error instanceof Error ? error.message : String(error) }, produced, pending: staged ? deps.edits.drafts.pending(request.path).length : 0, ...(sessionId ? { sessionId } : {}) };
    }
  })().finally(revoke);
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
      revoke();
      turnAbort.abort();
    },
  };
}

function statusOf({ outcome, pending }: InlineResult): InlineStatus {
  if (outcome.status === 'cancelled') return 'stopped';
  if (outcome.status === 'error') return 'failed';
  return pending > 0 ? 'staged' : 'no-change';
}
