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
  const inThread = (item: TimelineItem) => (item.kind === 'tool' || item.kind === 'text') && threadIds.has(item.threadId);

  return (
    <div class="timeline" ref={ref} onScroll={onScroll} aria-live="polite">
      {state.items.filter((item) => !inThread(item)).map((item) => {
        if (item.kind === 'thread') {
          const children = state.items.filter((c) => inThread(c) && (c.kind === 'tool' || c.kind === 'text') && c.threadId === item.id);
          const steps = children.filter((c) => c.kind === 'tool').length;
          return <ThreadBlock key={item.id} item={item} steps={steps}>{children.map(render)}</ThreadBlock>;
        }
        return render(item);
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
