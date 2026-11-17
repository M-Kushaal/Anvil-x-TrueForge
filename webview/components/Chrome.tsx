// Header, empty state and the working bar.
import { useEffect, useState } from 'preact/hooks';
import { send } from '../host';
import { Mark } from './Mark';
import { duration } from '../../src/shared/text';

export function Header({ title }: { title: string }) {
  return (
    <div class="header">
      <span class="header-title">{title}</span>
      <button class="icon-btn" onClick={() => send({ type: 'recoverChanges' })} aria-label="Recover pending tasks" title="Pending tasks saved on this workspace"><span class="codicon codicon-folder-opened" /></button>
      <button class="icon-btn" onClick={() => send({ type: 'settings' })} aria-label="Anvil settings" title="Setup and model settings"><span class="codicon codicon-gear" /></button>
      <button class="icon-btn" onClick={() => send({ type: 'history' })} aria-label="History" title="Earlier chats and inline edits">
        <span class="codicon codicon-history" />
      </button>
      <button class="icon-btn" onClick={() => send({ type: 'newChat' })} aria-label="New chat" title="New chat">
        <span class="codicon codicon-add" />
      </button>
    </div>
  );
}

const SUGGESTIONS = [
  'Explain how this project is structured',
  'Find where configuration is loaded',
  'Add a test for the selected function',
];

export function EmptyState({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div class="empty">
      <Mark size={32} class="mark" />
      <div>
        <div class="empty-title">Anvil</div>
        <div class="empty-line">Finds the right code, proposes changes you review hunk by hunk, and shows its work.</div>
      </div>
      <div class="chips">
        {SUGGESTIONS.map((s) => <button class="chip" key={s} onClick={() => onPick(s)}>{s}</button>)}
      </div>
      <div class="shortcuts">
        <kbd>Ctrl+I</kbd><span>Edit the selection inline</span>
        <kbd>Enter</kbd><span>Send · Shift+Enter for a new line</span>
        <kbd>Esc</kbd><span>Stop a running request</span>
      </div>
      <div class="setup-hint">Start TrueForge with <code>npm run forge</code> and register models with <code>npm run setup</code> in the Anvil extension folder. Use the + beside the model to pin context files.</div>
    </div>
  );
}

export function WorkingBar({ startedAt, activity }: { startedAt: number; activity?: string | undefined }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div class="working" role="status">
      <span class="spark"><Mark size={14} /></span>
      <span class="label">{activity ? 'Waiting' : 'Working'}… {duration(now - startedAt)}</span>
      {activity && <span class="activity" title={activity}>{activity}</span>}
    </div>
  );
}
