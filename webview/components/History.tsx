import type { SidebarHistory } from '../../src/shared/protocol';
import { send } from '../host';

export function History({ history, running }: { history: SidebarHistory; running: boolean }) {
  const inline = history.mode === 'inline';
  return <section class="sidebar-history" aria-label={inline ? 'Inline edit history' : 'Chat history'}>
    <div class="history-heading">
      <button class="text-btn" onClick={() => send({ type: 'sidebarBack' })}><span class="codicon codicon-arrow-left" aria-hidden="true" /> Back to chat</button>
      <strong>{inline ? 'Inline edits' : 'Chat history'}</strong>
    </div>
    {inline ? <>
      <button class="text-btn" onClick={() => send({ type: 'openSession', inline: true })}><span class="codicon codicon-link-external" aria-hidden="true" /> Open inline session in TrueForge</button>
      {!history.inlineEdits.length && <p>Select code and press Ctrl+I to start an inline edit.</p>}
      {[...history.inlineEdits].reverse().map((edit) => <article class="history-entry" key={edit.id}>
        <div class="history-inline-heading">
        <button class="text-btn" onClick={() => send({ type: 'openFile', path: edit.path, line: edit.startLine })}>
          {edit.path.split('/').pop()} &middot; lines {edit.startLine}-{edit.endLine}
        </button>
        <button class="icon-btn" disabled={edit.status === 'running'} title="Delete inline edit history entry" aria-label={`Delete inline edit for ${edit.path.split('/').pop()}`} onClick={() => send({ type: 'deleteInlineHistory', id: edit.id })}>
          <span class="codicon codicon-trash" />
        </button>
        </div>
        <p>{edit.instruction}</p>
        <span class="micro">{edit.status === 'staged' ? 'Pending review' : edit.status === 'no-change' ? 'No change' : edit.status.charAt(0).toUpperCase() + edit.status.slice(1)}</span>
        {edit.detail && <p class="micro">{edit.detail}</p>}
      </article>)}
    </> : <>
      <button class="text-btn" onClick={() => send({ type: 'inlineHistory' })}><span class="codicon codicon-edit" aria-hidden="true" /> Inline edit history <span class="codicon codicon-chevron-right" aria-hidden="true" /></button>
      <button class="text-btn" onClick={() => send({ type: 'openSession' })}><span class="codicon codicon-link-external" aria-hidden="true" /> Open current chat in TrueForge</button>
      {!history.chats.length && <p>No saved chats yet.</p>}
      {history.chats.map((chat) => <div class="history-entry history-chat" key={chat.sessionId}>
        <button class="text-btn history-open" disabled={running} onClick={() => send({ type: 'resumeChat', sessionId: chat.sessionId })}>
          <span class="history-chat-title"><span class="codicon codicon-comment" aria-hidden="true" /><strong>{chat.title}</strong></span>
          <time dateTime={new Date(chat.at).toISOString()} title={new Date(chat.at).toLocaleString()}>{new Date(chat.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} &middot; {new Date(chat.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</time>
        </button>
        <button class="icon-btn" disabled={running} title="Delete chat" aria-label={`Delete chat ${chat.title}`} onClick={() => send({ type: 'deleteChat', sessionId: chat.sessionId })}>
          <span class="codicon codicon-trash" />
        </button>
      </div>)}
    </>}
  </section>;
}
