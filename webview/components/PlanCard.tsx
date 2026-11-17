// The agent's checklist, updated in place as steps finish.
import type { PlanStep } from '../../src/shared/protocol';

const ICON: Record<PlanStep['status'], string> = { done: 'pass-filled', doing: 'circle-large-filled', todo: 'circle-large-outline' };
const LABEL: Record<PlanStep['status'], string> = { done: 'done', doing: 'in progress', todo: 'to do' };

export function PlanCard({ steps }: { steps: PlanStep[] }) {
  const done = steps.filter((s) => s.status === 'done').length;
  return (
    <section class="plan" aria-label="Plan">
      <div class="context-head">
        <span class="micro">Plan</span>
        <span class="context-total">{done} of {steps.length} done</span>
      </div>
      <ul class="plan-list">
        {steps.map((step, i) => (
          <li key={i} class={`plan-step ${step.status}`}>
            <span class={`codicon codicon-${ICON[step.status]}`} aria-label={LABEL[step.status]} />
            <span>{step.title}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
