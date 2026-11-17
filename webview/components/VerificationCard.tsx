import type { Verification } from '../../src/shared/protocol';

const LABELS: Record<Verification['status'], string> = {
  passed: 'Last command passed', failed: 'Last command failed', cancelled: 'Command cancelled',
  timedOut: 'Command timed out', outdated: 'Result outdated — run checks again',
};

export function VerificationCard({ result }: { result?: Verification }) {
  if (!result) return null;
  return (
    <details class={`verification ${result.status}`}>
      <summary>{LABELS[result.status]} <span class="verification-code">{result.code === null ? '' : `exit ${result.code}`}</span></summary>
      <div class="verification-body">
        <div class="micro">Command</div>
        <pre>{result.command}</pre>
        <div class="verification-meta">{new Date(result.at).toLocaleTimeString()} · temporary workspace copy · host permissions</div>
        <pre aria-label="Command output">{result.output || 'No output.'}</pre>
        <p>This records this command only. Later edits invalidate the result; a successful command does not establish that all tests passed.</p>
      </div>
    </details>
  );
}
