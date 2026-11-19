// Orders rows and nests subagent work under its thread row; keeps the view pinned to the bottom
// while streaming unless the user has scrolled up.
import { useEffect, useRef } from 'preact/hooks';
import type { ChatState, TimelineItem } from '../../src/shared/protocol';
import { Notice, Prose, ThreadBlock, ToolRow, UserMessage } from './Rows';
import { ContextCard } from './ContextCard';
import { PlanCard } from './PlanCard';
import { compactNumber, duration } from '../../src/shared/text';

export function Timeline({ state }: { state: ChatState }) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [state]);

  const onScroll = () => {
    const el = ref.current;
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const threadIds = new Set(state.items.filter((i) => i.kind === 'thread').map((i) => i.id));
  const threads = new Map<string, TimelineItem[]>();
  const main: TimelineItem[] = [];
  for (const item of state.items) {
    if ((item.kind === 'tool' || item.kind === 'text') && threadIds.has(item.threadId)) {
      const children = threads.get(item.threadId) ?? [];
      children.push(item);
      threads.set(item.threadId, children);
    } else main.push(item);
  }

  return (
    <div class="timeline" ref={ref} onScroll={onScroll} role="region" aria-label="Chat activity" tabIndex={0}>
      {main.map((item) => {
        if (item.kind !== 'thread') return render(item);
        const children = threads.get(item.id) ?? [];
        const steps = children.filter((child) => child.kind === 'tool').length;
        return <ThreadBlock key={item.id} item={item} steps={steps}>{children.map(render)}</ThreadBlock>;
      })}
      {!state.running && state.lastTurn && state.lastTurn.ms > 0 && (
        <div class="turn-meta">{compactNumber(state.lastTurn.tokens)} tokens in {duration(state.lastTurn.ms)}</div>
      )}
    </div>
  );
}

function render(item: TimelineItem) {
  switch (item.kind) {
    case 'user': return <UserMessage key={item.id} item={item} />;
    case 'text': return <Prose key={item.id} item={item} />;
    case 'tool': return <ToolRow key={item.id} item={item} />;
    case 'notice': return <Notice key={item.id} item={item} />;
    case 'context': return <ContextCard key={item.id} context={item.context} />;
    case 'plan': return <PlanCard key={item.id} steps={item.steps} />;
    default: return null;
  }
}
