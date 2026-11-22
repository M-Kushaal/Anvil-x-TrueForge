import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import '@vscode/codicons/dist/codicon.css';
import './styles/tokens.css';
import './styles/app.css';
import type { ChatState, ToWebview } from '../src/shared/protocol';
import { send } from './host';
import { History } from './components/History';
import { Composer } from './components/Composer';
import { EmptyState, Header, WorkingBar } from './components/Chrome';
import { Timeline } from './components/Timeline';
import { ChangesCard } from './components/Changes';
import { VerificationCard } from './components/VerificationCard';

const EMPTY: ChatState = { title: 'New chat', items: [], running: false, model: '', changes: [] };

export function App({ initial = EMPTY }: { initial?: ChatState }) {
  const [state, setState] = useState<ChatState>(initial);
  const [draft, setDraft] = useState<string | undefined>();

  useEffect(() => {
    const onMessage = (event: MessageEvent<ToWebview>) => {
      if (event.data?.type === 'state') setState(event.data.state);
    };
    window.addEventListener('message', onMessage);
    send({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const stopOnEscape = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && !event.isComposing && state.running) {
      event.preventDefault();
      send({ type: 'stop' });
    }
  };

  return (
    <div class="app" onKeyDown={stopOnEscape}>
      <Header title={state.sidebar?.mode === 'inline' ? 'Inline edits' : state.sidebar?.mode === 'history' ? 'History' : state.title} />
      {state.sidebar && state.sidebar.mode !== 'chat' ? <History history={state.sidebar} running={state.running} /> : <>
      {state.items.length === 0 ? <EmptyState onPick={setDraft} /> : <Timeline state={state} />}
      </>}
      {state.running && state.startedAt && <WorkingBar startedAt={state.startedAt} activity={state.activity} />}
      {state.connection?.ok === false && (
        <div class="offline" role="alert">
          <span class="codicon codicon-debug-disconnect" />
          <span class="offline-text">{state.connection.message ?? 'Not connected to TrueForge.'}</span>
          <button class="btn" onClick={() => send({ type: 'reconnect' })}>Retry</button>
          <button class="btn" onClick={() => send({ type: 'settings' })}>Setup</button>
        </div>
      )}
      <VerificationCard result={state.verification} />
      <ChangesCard changes={state.changes} running={state.running} checkpointAvailable={state.checkpointAvailable} />
      {!!state.contextFiles?.length && <div class="attachments" aria-label="Pinned context files">
        {state.contextFiles.map((path) => <button class="chip" key={path} title={`Remove ${path} from context`} onClick={() => send({ type: 'removeContext', path })}>{path} ×</button>)}
      </div>}
      {!!state.contextExcluded?.length && <div class="attachments" aria-label="Excluded from initial context">
        {state.contextExcluded.map((path) => <button class="chip" key={path} title={`Include ${path} again`} onClick={() => send({ type: 'restoreContext', path })}>Excluded: {path} ×</button>)}
      </div>}
      {state.sidebar?.mode !== 'history' && (state.sidebar?.mode !== 'inline' || state.inlineSelection) && <Composer inlineSelection={state.inlineSelection} running={state.running} model={state.model} draft={draft} offline={state.connection?.ok === false} onDraftUsed={() => setDraft(undefined)} />}
    </div>
  );
}

const root = document.getElementById('root');
if (root) render(<App />, root);
