// update_plan: the agent publishes its checklist; the chat shows it as a live Plan card.
import { z } from 'zod';
import type { PlanStep } from '../shared/protocol';
import { defineTool, type Tool } from './tool';

export function planTool(onPlan: (steps: PlanStep[]) => void): Tool {
  return defineTool({
    name: 'update_plan',
    description: 'Publish or update your plan as a short checklist (3-6 steps) shown to the user. Call it before editing and again as steps finish.',
    input: {
      steps: z.array(z.object({
        title: z.string().describe('Short imperative step, e.g. "Add a retry option to the client"'),
        status: z.enum(['todo', 'doing', 'done']),
      })).min(1).max(10),
    },
    annotations: { readOnlyHint: true },
    run: async ({ steps }) => {
      onPlan(steps);
      const done = steps.filter((s) => s.status === 'done').length;
      return `plan · ${done}/${steps.length} done`;
    },
  });
}
