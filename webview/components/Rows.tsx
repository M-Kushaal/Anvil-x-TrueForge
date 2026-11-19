// Timeline rows: user message, assistant prose, one-line tool rows, subagent threads, notices.
import { useMemo, useState } from 'preact/hooks';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { TimelineItem } from '../../src/shared/protocol';
import { toolLabel } from '../../src/shared/labels';
import { plural } from '../../src/shared/text';
import { send } from '../host';

type Item<K extends TimelineItem['kind']> = Extract<TimelineItem, { kind: K }>;

const EDIT_TOOLS = new Set(['propose_edit', 'create_file']);

export function UserMessage({ item }: { item: Item<'user'> }) {
  return <div class="user-msg">{item.text}</div>;
}

export function Prose({ item }: { item: Item<'text'> }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(item.text, { async: false, gfm: true, breaks: false })), [item.text]);
  return <div class="prose" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function ToolRow({ item }: { item: Item<'tool'> }) {
  const [open, setOpen] = useState(false);
  const { verb, target } = toolLabel(item.name, item.args, item.status);
  const path = pathArg(item.args);
  const statusText = { running: 'running', waiting: 'waiting for you', done: 'done', error: 'failed', stopped: 'stopped' }[item.status];
  return (
    <>
      <div class="row">
        <span class={`dot ${item.status}`} aria-hidden="true" />
        <span class="row-main">
          <button type="button" class="row-toggle text-btn" aria-expanded={open}
            aria-label={`${verb} ${target ?? ''} details (${statusText})`.replace(/ +/g, ' ')}
            onClick={() => setOpen(!open)}>
            <span class="verb">{verb}</span>
            <span aria-hidden="true" class={`codicon codicon-chevron-${open ? 'down' : 'right'}`} />
          </button>
          {target && (path ? (
            <button type="button" class="target link"
              onClick={() => send(EDIT_TOOLS.has(item.name) ? { type: 'review', path } : { type: 'openFile', path })}
              title={EDIT_TOOLS.has(item.name) ? `Review ${path}` : path}>{target}</button>
          ) : <span class="target">{target}</span>)}
          {item.summary && <span class="summary">· {withStats(stripTarget(item.summary, [path, target]))}</span>}
        </span>
      </div>
      {item.name === 'run_command' && item.status === 'waiting' && (
        <div class="approve" role="group" aria-label="Approve command">
          <pre class="approval-command">{commandArg(item.args)}</pre>
          <span class="approve-text">Run this command? It runs on a copy of the workspace, with your permissions.</span>
          <button class="btn primary" onClick={() => send({ type: 'approve', id: item.id, allow: true })}>Run</button>
          <button class="btn" onClick={() => send({ type: 'approve', id: item.id, allow: false })}>Skip</button>
        </div>
      )}
      {open && <div class="row-detail"><div class="micro">Arguments</div><pre>{prettyArgs(item.args)}</pre>{item.output && <><div class="micro">Result</div><pre>{item.output}</pre></>}</div>}
    </>
  );
}

function commandArg(args: string): string {
  try { return String((JSON.parse(args) as { command?: unknown }).command ?? args); } catch { return args; }
}

export function ThreadBlock({ item, steps, children }: { item: Item<'thread'>; steps: number; children: preact.ComponentChildren }) {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <button type="button" class="row clickable thread-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span class={`dot ${item.status}`} />
        <span class="row-main">
          <span class="verb">Subagent</span>
          <span class="summary">{item.title} · {plural(steps, 'step')}</span>
        </span>
        <span class={`codicon codicon-chevron-${open ? 'down' : 'right'}`} />
      </button>
      {open && <div class="thread">{children}</div>}
    </div>
  );
}

export function Notice({ item }: { item: Item<'notice'> }) {
  const icon = { info: 'info', warn: 'warning', error: 'error' }[item.level];
  return (
    <div class={`notice ${item.level}`} role={item.level === 'error' ? 'alert' : 'status'}>
      <span class={`codicon codicon-${icon}`} />
      <div>
        <div class="notice-title">{item.title}</div>
        {item.detail && <div class="notice-detail">{item.detail}</div>}
      </div>
    </div>
  );
}

function pathArg(args: string): string | undefined {
  try {
    const value = JSON.parse(args) as { path?: unknown };
    return typeof value.path === 'string' && value.path !== '.' ? value.path : undefined;
  } catch {
    return undefined;
  }
}

/** Summaries lead with the path or query ("a.py · lines 1–10"); the row already shows it. */
function stripTarget(summary: string, targets: Array<string | undefined>): string {
  const lead = targets.find((t) => t && summary.startsWith(`${t} · `));
  return lead ? summary.slice(lead.length + 3) : summary;
}

/** Colours "+12" and "−3" like the Changes card. */
function withStats(text: string) {
  return text.split(/(\+\d+|−\d+)/).map((part, i) =>
    /^\+\d+$/.test(part) ? <span key={i} class="add">{part}</span> : /^−\d+$/.test(part) ? <span key={i} class="del">{part}</span> : part);
}

function prettyArgs(args: string): string {
  try {
    return JSON.stringify(JSON.parse(args), null, 2);
  } catch {
    return args;
  }
}
