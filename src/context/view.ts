// Shapes a context pack for the chat timeline.
import type { ContextView } from '../shared/protocol';
import type { ContextEngine } from './engine';
import type { ContextPack } from './pack';

export function toContextView(pack: ContextPack, engine: ContextEngine): ContextView {
  const graph = engine.graphSource === 'graphify' ? 'Ranked by keywords and the code graph' : 'Ranked by keywords (no code graph yet)';
  return {
    used: pack.used,
    budget: pack.budget,
    items: pack.items.map(({ kind, path, tokens, reasons }) => ({ kind, path, tokens, reasons })),
    dropped: pack.dropped,
    source: `${graph} · ${engine.fileCount} files`,
  };
}
