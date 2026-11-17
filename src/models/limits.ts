// Per-model request settings. Small-limit providers (Groq's free tier caps a request at 8k tokens,
// output included) get a lean spec, a smaller context pack and earlier compaction.

export interface Settings {
  leanProviders: string[];
  compactAt: number;
  contextBudget: number;
}

export interface RequestLimits {
  lean: boolean;
  compactAt: number;
  contextBudget: number;
}

// Pack plus fixed prompt ≈ 3.7k; compaction at 6k and 1.5k of output stay under 8k per request.
const LEAN = { compactAt: 6000, contextBudget: 1800 };

/** Matches a listed provider and its suffixed variants: "groq" covers groq, groq-2, groq-backup. */
export function limitsFor(model: string, settings: Settings): RequestLimits {
  const provider = model.split('/')[0] ?? '';
  const lean = settings.leanProviders.some((p) => provider === p || provider.startsWith(`${p}-`));
  if (!lean) return { lean, compactAt: settings.compactAt, contextBudget: settings.contextBudget };
  return { lean, compactAt: Math.min(settings.compactAt, LEAN.compactAt), contextBudget: Math.min(settings.contextBudget, LEAN.contextBudget) };
}

/** The agent-spec options for a model: lean mode and its compaction threshold. */
export function specFor(model: string, settings: Settings): { lean: boolean; config: Record<string, unknown> } {
  const { lean, compactAt } = limitsFor(model, settings);
  return { lean, config: { context_management: { compaction: { enabled: true, trigger: { type: 'input_tokens', value: compactAt } } } } };
}
