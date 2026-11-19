// Auto-growing input. Enter sends, Shift+Enter adds a line.
import { useEffect, useRef, useState } from 'preact/hooks';
import { send } from '../host';

export function Composer({ running, model, draft, offline, onDraftUsed }: { running: boolean; model: string; draft?: string; offline?: boolean; onDraftUsed?: () => void }) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (draft === undefined) return;
    setText(draft);
    onDraftUsed?.();
    ref.current?.focus();
  }, [draft]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  const submit = () => {
    if (running || offline || !text.trim()) return;
    send({ type: 'send', text });
    setText('');
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
  };

  return (
    <div class="composer">
      <label class="sr-only" for="anvil-input">Message Anvil</label>
      <textarea
        id="anvil-input"
        ref={ref}
        rows={2}
        value={text}
        placeholder="Ask Anvil"
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        onKeyDown={onKeyDown}
      />
      <div class="composer-foot">
        <button class="icon-btn" disabled={running} onClick={() => send({ type: 'attachContext' })} aria-label="Attach context files" title="Pin files to the next request"><span class="codicon codicon-add" /></button>
        <button class="model text-btn" disabled={running} onClick={() => send({ type: 'selectModel' })} title="Choose model for a new chat">{model || 'Choose model'} <span class="codicon codicon-chevron-down" /></button>
        {running ? (
          <button class="send stop" onClick={() => send({ type: 'stop' })} aria-label="Stop (Esc)" title="Stop (Esc)">
            <span class="codicon codicon-debug-stop" />
          </button>
        ) : (
          <button class={`send${text.trim() ? ' ready' : ''}`} onClick={submit} disabled={offline || !text.trim()} aria-label="Send (Enter)" title={offline ? 'Connect TrueForge before sending' : 'Send (Enter)'}>
            <span class="codicon codicon-send" />
          </button>
        )}
      </div>
    </div>
  );
}
