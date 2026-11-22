// Scripted stand-in for the TrueForge SDK. Each turn replays the next script; a `'hang'` entry
// blocks until `cancel` is called, then ends the turn as cancelled.
import { vi } from 'vitest';
import type { ForgeApi } from '../../src/forge/client';

export type Step = object | 'hang' | 'waitForApproval';

export function fakeForge(...turns: Step[][]) {
  let release: (() => void) | undefined;
  let postedApproval: (() => void) | undefined;
  let cancelled = false; // a cancel may arrive before the stream reaches its 'hang' step
  const posted: object[] = [];
  const created: object[] = [];
  const updates: object[] = [];
  let turn = 0;
  const api: ForgeApi = {
    sessions: {
      create: vi.fn(async (request: object) => { created.push(request); return { data: { id: `s${created.length}` } }; }),
      createTurnEvents: vi.fn(async (_s: string, _t: string, body: object) => { posted.push(body); postedApproval?.(); }),
      cancel: vi.fn(async () => { cancelled = true; release?.(); }),
      update: vi.fn(async (_s: string, body: object) => { updates.push(body); }),
      createTurnStream: vi.fn(async () => {
        const script = turns[Math.min(turn++, turns.length - 1)] ?? [];
        return {
          async *withMetadata() {
            for (const step of script) {
              if (step === 'waitForApproval') {
                if (!posted.length) await new Promise<void>((resolve) => { postedApproval = resolve; });
                continue;
              }
              if (step === 'hang') {
                if (!cancelled) await new Promise<void>((resolve) => { release = resolve; });
                cancelled = false;
                yield { data: { type: 'turn.done', id: 'd', state: { status: 'cancelled', reason: 'client-cancelled' } } };
                return;
              }
              yield { data: step };
            }
          },
        };
      }),
    },
  };
  return { api, posted, created, updates };
}
