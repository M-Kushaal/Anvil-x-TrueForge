// Auto-growing input. Enter sends, Shift+Enter adds a line.
import { useEffect, useRef, useState } from 'preact/hooks';
import { send } from '../host';
import type { ChatState } from '../../src/shared/protocol';

export function Composer({ running, model, draft, offline, inlineSelection, onDraftUsed }: { running: boolean; model: string; draft?: string; offline?: boolean; inlineSelection?: ChatState['inlineSelection']; onDraftUsed?: () => void }) {
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

  useEffect(() => {
    if (inlineSelection) ref.current?.focus();
  }, [inlineSelection?.file, inlineSelection?.start, inlineSelection?.end]);

  const localCommand = /^\/(model|rewind|usage)$/i.test(text.trim());
  const submit = () => {
    if (running || (offline && !localCommand) || !text.trim()) return;
    send({ type: inlineSelection ? 'inlineInstruction' : 'send', text });
    setText('');
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && inlineSelection) { e.preventDefault(); send({ type: 'cancelInlineInstruction' }); return; }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
  };

  return (
    <div class="composer">
      {text.trim().startsWith('/') && !running && !inlineSelection && (
        <div class="composer-commands">
          {['/model', '/rewind', '/usage'].filter((command) => command.startsWith(text.trim().toLowerCase())).map((command) => (
            <button class="text-btn" type="button" onClick={() => { send({ type: 'send', text: command }); setText(''); }}>
              {command} {command === '/model' ? 'Choose a model' : command === '/usage' ? 'Chat token usage' : 'Rewind last edit request'}
            </button>
          ))}
        </div>
      )}
      <label class="sr-only" for="anvil-input">Message Anvil</label>
      <textarea
        id="anvil-input"
        ref={ref}
        rows={2}
        value={text}
        placeholder={inlineSelection ? 'Describe the change to your selection' : 'Ask Anvil'}
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        onKeyDown={onKeyDown}
      />
      {inlineSelection && <div class="inline-selection">
        <span>{inlineSelection.file} &middot; lines {inlineSelection.start}-{inlineSelection.end}</span>
        <button class="icon-btn" aria-label="Cancel inline edit" onClick={() => send({ type: 'cancelInlineInstruction' })}><span class="codicon codicon-close" /></button>
      </div>}
      <div class="composer-foot">
        <button class="icon-btn" disabled={running} onClick={() => send({ type: 'attachContext' })} aria-label="Attach context files" title="Pin files to the next request"><span class="codicon codicon-add" /></button>
        <button class="model text-btn" disabled={running} onClick={() => send({ type: 'selectModel' })} title="Choose model for this chat">{model || 'Choose model'} <span class="codicon codicon-chevron-down" /></button>
        {running ? (
          <button class="send stop" onClick={() => send({ type: 'stop' })} aria-label="Stop (Esc)" title="Stop (Esc)">
            <span class="codicon codicon-debug-stop" />
          </button>
        ) : (
          <button class={`send${text.trim() ? ' ready' : ''}`} onClick={submit} disabled={(offline && !localCommand) || !text.trim()} aria-label="Send (Enter)" title={offline ? 'Connect TrueForge before sending' : 'Send (Enter)'}>
            <span class="codicon codicon-send" />
          </button>
        )}
      </div>
    </div>
  );
}
