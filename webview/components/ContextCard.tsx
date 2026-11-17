// What the model was given and why: budget meter, one row per chosen file with its reasons,
// and the files left out. Segments use the theme's chart palette; the legend is on hover.
import { useState } from 'preact/hooks';
import type { ContextView } from '../../src/shared/protocol';
import { compactNumber } from '../../src/shared/text';
import { send } from '../host';

const ROLE: Record<ContextView['items'][number]['kind'], string> = {
  mention: 'Mentioned', impl: 'Implementation', test: 'Test', docs: 'Docs', related: 'Related',
};

export function ContextCard({ context }: { context: ContextView }) {
  const [showDropped, setShowDropped] = useState(false);
  const { used, budget, items, dropped, source } = context;
  const scale = Math.max(budget, used);
  return (
    <section class="context" aria-label="Context sent with this request">
      <div class="context-head">
        <span class="micro">Context</span>
        <span class="context-total">{compactNumber(used)} / {compactNumber(budget)} tokens</span>
      </div>
      <div class="meter" role="img" aria-label={`${used} of ${budget} tokens used`}>
        {items.filter((i) => i.tokens > 0).map((i) => (
          <span key={i.path} class={`seg seg-${i.kind}`} style={{ width: `${(i.tokens / scale) * 100}%` }} title={`${ROLE[i.kind]}: ${i.path}, ${i.tokens} tokens`} />
        ))}
      </div>
      <ul class="context-list">
        {items.map((i) => (
          <li key={i.path} class="context-row">
            <span class={`role role-${i.kind}`}>{ROLE[i.kind]}</span>
            <button class="target link" onClick={() => send({ type: 'openFile', path: i.path })} title={i.path}>{i.path.split('/').pop()}</button>
            <span class="context-tokens">{i.tokens > 0 ? `${compactNumber(i.tokens)} tok` : ''}</span>
            {i.reasons.length > 0 && <span class="context-why">{i.reasons.join('; ')}</span>}
            <span class="context-controls"><button class="text-btn" title="Pin for future requests in this task" onClick={() => send({ type: 'pinContext', path: i.path })}>Pin</button><button class="text-btn" title="Exclude from initial context on future requests; the agent can still read it" onClick={() => send({ type: 'excludeContext', path: i.path })}>Exclude</button></span>
          </li>
        ))}
      </ul>
      {dropped.length > 0 && (
        <button class="text-btn context-more" onClick={() => setShowDropped(!showDropped)} aria-expanded={showDropped}>
          <span class={`codicon codicon-chevron-${showDropped ? 'down' : 'right'}`} /> Not included ({dropped.length})
        </button>
      )}
      {showDropped && (
        <ul class="context-dropped">
          {dropped.map((d) => <li key={d.path}><span class="mono">{d.path}</span> <span class="context-why">{d.reason}</span></li>)}
        </ul>
      )}
      <div class="context-source">{source}</div>
    </section>
  );
}
