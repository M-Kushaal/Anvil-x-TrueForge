// Pending changes: always visible above the composer while anything is unwritten.
import type { FileChange } from '../../src/shared/protocol';
import { plural } from '../../src/shared/text';
import { send } from '../host';

export function ChangesCard({ changes, running, checkpointAvailable }: { changes: FileChange[]; running: boolean; checkpointAvailable?: boolean }) {
  if (changes.length === 0) return checkpointAvailable ? <section class="changes" aria-label="Proposal checkpoint"><div class="changes-actions"><span class="changes-note">A pending-proposal checkpoint is saved. Restoring it does not revert files you kept.</span><button class="btn" disabled={running} onClick={() => send({ type: 'restoreCheckpoint' })}>Restore checkpoint</button></div></section> : null;
  const added = changes.reduce((n, c) => n + c.added, 0);
  const removed = changes.reduce((n, c) => n + c.removed, 0);
  const hunks = changes.reduce((n, c) => n + c.hunks, 0);
  return (
    <section class="changes" aria-label="Pending changes">
      <div class="changes-head">
        <span class="micro">{plural(changes.length, 'file')} to review</span>
        <span class="change-stats"><span class="add">+{added}</span> <span class="del">−{removed}</span></span>
      </div>
      <ul class="changes-list">
        {changes.map((c) => (
          <li key={c.path}>
            <button class="change-row" onClick={() => send({ type: 'review', path: c.path })} title={`Review ${c.path}`}>
              <span class="change-name">{c.path.split('/').pop()}</span>
              <span class="change-dir">{c.isNew ? 'new file' : c.path.split('/').slice(0, -1).join('/')}</span>
              <span class="change-stats"><span class="add">+{c.added}</span> <span class="del">−{c.removed}</span></span>
            </button>
          </li>
        ))}
      </ul>
      <div class="changes-actions">
        <button class="btn primary" onClick={() => send({ type: 'review' })}>Review</button>
        <button class="btn" onClick={() => send({ type: 'keepAll' })} disabled={running} title={running ? 'Available when Anvil finishes' : 'Write every change'}>Keep all</button>
        <button class="btn" onClick={() => send({ type: 'discardAll' })}>Reject all</button>
        <button class="text-btn" title="Save pending proposals; this does not checkpoint disk files" disabled={running} onClick={() => send({ type: 'checkpoint' })}>Save checkpoint</button>
        {checkpointAvailable && <button class="text-btn" disabled={running} onClick={() => send({ type: 'restoreCheckpoint' })}>Restore checkpoint</button>}
        <span class="changes-note">Review related implementation and test changes together.</span>
        <span class="changes-note">{plural(hunks, 'change')} waiting, nothing written yet</span>
      </div>
    </section>
  );
}
