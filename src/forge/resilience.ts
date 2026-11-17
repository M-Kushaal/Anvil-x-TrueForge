// What to do when a model call fails: classify the error, then retry, switch to another model in
// the chain, or give up. Pure policy: callers own time, sessions and the timeline.

export type ErrorKind = 'auth' | 'not_found' | 'rate_limit' | 'too_large' | 'network' | 'server' | 'timeout' | 'bad_tool_call' | 'tools' | 'unknown';

export interface Classified {
  kind: ErrorKind;
  /** Short human text, e.g. "401 invalid API key". */
  summary: string;
  retryAfterMs?: number;
}

export function classify(message = ''): Classified {
  // TrueForge cannot reach Anvil's own MCP server: every model would fail the same way.
  if (/^\[MCP Error\]/.test(message)) return { kind: 'tools', summary: 'editor tools unreachable' };
  const m = message.replace(/^\[Model Error\]\s*/, '');
  const status = /\((\d{3})\)/.exec(m)?.[1] ?? /\b(4\d\d|5\d\d)\b/.exec(m)?.[1];
  const retryAfterMs = parseRetryAfter(m);
  // One request bigger than the per-minute budget can never succeed on this model: move on.
  if (status === '413' || /request too large|requested \d+.*limit \d+|context length|maximum context|too many tokens/i.test(m) && !/try again in/i.test(m)) {
    return { kind: 'too_large', summary: 'request larger than the model allows' };
  }
  if (status === '429' || /rate limit|too many requests|quota/i.test(m)) {
    return { kind: 'rate_limit', summary: '429 rate limited', ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
  }
  // The model produced a malformed tool call; the provider is fine, so try again.
  if (/tool call validation failed|did not match schema|failed to call a function|tool_use_failed|invalid tool call|failed to parse tool call/i.test(m)) {
    return { kind: 'bad_tool_call', summary: 'malformed tool call from the model' };
  }
  if (status === '401' || status === '403' || /invalid api key|unauthori[sz]ed|forbidden|authentication/i.test(m)) {
    return { kind: 'auth', summary: `${status ?? '401'} ${/invalid api key/i.test(m) ? 'invalid API key' : 'not authorised'}` };
  }
  if (status === '404' || /does not exist|model not found|no such model|unknown model/i.test(m)) return { kind: 'not_found', summary: `${status ?? '404'} model not found` };
  if (/cannot connect|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|bad port|network|socket hang up|ECONNRESET/i.test(m)) return { kind: 'network', summary: 'endpoint unreachable' };
  if (/timed? ?out|timeout|ETIMEDOUT/i.test(m)) return { kind: 'timeout', summary: 'request timed out' };
  if ((status && status.startsWith('5')) || /internal server error|bad gateway|service unavailable|overloaded/i.test(m)) return { kind: 'server', summary: `${status ?? '5xx'} server error` };
  return { kind: 'unknown', summary: m.slice(0, 120) || 'unknown error' };
}

export type Step =
  | { action: 'retry'; delayMs: number }
  | { action: 'switch'; to: number; delayMs?: number }
  | { action: 'give_up' };

const BACKOFF_MS = [1000, 3000];
const MAX_RATE_WAIT_MS = 65_000; // per-minute windows always reset within this
const MAX_TWIN_HOPS = 12;

/**
 * Decides the next move after `error` on `chain[index]`, given retries already spent on that model.
 * `cooldowns` maps chain indices to how long (ms from now) each is known to stay rate limited.
 */
export function nextStep({ chain, index, retries, error, cooldowns = {} }: { chain: string[]; index: number; retries: number; error: Classified; cooldowns?: Record<number, number> }): Step {
  const switchTo = nextModel(chain, index, error.kind === 'auth');
  const orGiveUp = (): Step => (switchTo === undefined ? { action: 'give_up' } : { action: 'switch', to: switchTo });
  switch (error.kind) {
    case 'rate_limit': {
      const wait = error.retryAfterMs ?? 10_000;
      // The same model under another account has its own quota: use whichever of the pair is free first.
      const twin = twinOf(chain, index);
      if (twin !== undefined && retries < MAX_TWIN_HOPS) {
        const twinWait = Math.max(0, cooldowns[twin] ?? 0);
        if (Math.min(wait, twinWait) <= MAX_RATE_WAIT_MS) {
          return twinWait < wait ? { action: 'switch', to: twin, delayMs: twinWait && twinWait + 500 } : { action: 'retry', delayMs: wait + 500 };
        }
      }
      // Per-minute limits reset quickly: waiting keeps the stronger model.
      return retries < 6 && wait <= MAX_RATE_WAIT_MS ? { action: 'retry', delayMs: wait + 500 } : orGiveUp();
    }
    case 'bad_tool_call':
      return retries < 2 ? { action: 'retry', delayMs: 0 } : orGiveUp();
    case 'network':
    case 'timeout':
    case 'server':
      return retries < BACKOFF_MS.length ? { action: 'retry', delayMs: BACKOFF_MS[retries]! } : orGiveUp();
    case 'tools':
      return { action: 'give_up' };
    default:
      return orGiveUp(); // auth, not_found, unknown: retrying the same model will not help
  }
}

/** Another chain entry serving the same model through a different provider (e.g. a second API key). */
export function twinOf(chain: string[], index: number): number | undefined {
  const [provider, ...rest] = (chain[index] ?? '').split('/');
  const model = rest.join('/');
  const i = chain.findIndex((c, j) => j !== index && c.split('/')[0] !== provider && c.split('/').slice(1).join('/') === model);
  return i < 0 ? undefined : i;
}

/** Next model in the chain. A rejected key fails every model on that provider, so skip them. */
function nextModel(chain: string[], index: number, skipSameProvider: boolean): number | undefined {
  const provider = (chain[index] ?? '').split('/')[0];
  for (let i = index + 1; i < chain.length; i++) {
    if (!skipSameProvider || chain[i]!.split('/')[0] !== provider) return i;
  }
  return undefined;
}

export interface RecoveryNotice {
  level: 'warn' | 'error';
  title: string;
  detail: string;
}

/** The notice shown for a step, e.g. "groq/gpt-oss-120b: 401 invalid API key. Continuing on ollama/…". */
export function describeStep({ chain, index, error, step }: { chain: string[]; index: number; error: Classified; step: Step }): RecoveryNotice {
  const from = chain[index] ?? 'model';
  if (step.action === 'retry') {
    const when = step.delayMs ? `in ${Math.round(step.delayMs / 1000)}s` : 'now';
    return { level: 'warn', title: 'Retrying', detail: `${from}: ${error.summary}. Retrying ${when}.` };
  }
  if (step.action === 'switch') {
    const when = step.delayMs ? ` in ${Math.round(step.delayMs / 1000)}s` : '';
    return { level: 'warn', title: 'Switched model', detail: `${from}: ${error.summary}. Continuing on ${chain[step.to]}${when}.` };
  }
  if (error.kind === 'tools') return { level: 'error', title: 'Editor tools unreachable', detail: 'TrueForge could not reach Anvil\'s tools. Run "Developer: Reload Window", then try again. Your files are unchanged.' };
  return { level: 'error', title: 'No model reachable', detail: `${from}: ${error.summary}. Every model in anvil.models failed. Your files are unchanged. Check the models in TrueForge (Settings → Models).` };
}

/** "try again in 25.86s", "in 750ms", "in 1m2.5s", "retry in 41.2s" (Gemini), "retry-after: 12", "retryDelay": "41s". */
function parseRetryAfter(m: string): number | undefined {
  const t = /(?:try again|retry) in\s+(?:(\d+)h)?(?:(\d+)m(?!s))?(?:([\d.]+)(ms|s))?/i.exec(m);
  if (t && (t[1] || t[2] || t[3])) {
    const seconds = Number(t[1] ?? 0) * 3600 + Number(t[2] ?? 0) * 60 + (t[3] ? Number(t[3]) / (t[4]?.toLowerCase() === 'ms' ? 1000 : 1) : 0);
    return Math.ceil(seconds * 1000);
  }
  const header = /retry[- ]?(?:after|delay)["':\s]+([\d.]+)/i.exec(m);
  return header ? Math.ceil(Number(header[1]) * 1000) : undefined;
}
