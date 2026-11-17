// Builds the context pack sent with a request: one file per role (implementation, test, docs),
// chosen by keyword (BM25), code-graph and "sibling pattern" signals, packed as outlines and
// line-numbered snippets under a token budget. Every choice carries a human-readable reason. Pure.
import type { OutlineSymbol } from './outline';
import { stem, tokenize, type LexicalIndex } from './lexical';
import { linkWeight, neighbours, type FileGraph } from './graph';

export type Role = 'impl' | 'test' | 'docs';
export type ItemKind = Role | 'mention' | 'related';

export interface PackItem {
  kind: ItemKind;
  path: string;
  score: number;
  reasons: string[];
  tokens: number;
}

export interface ContextPack {
  strategy: string;
  budget: number;
  used: number;
  roles: Role[];
  items: PackItem[];
  dropped: Array<{ path: string; reason: string }>;
  /** Appended to the user's message. */
  text: string;
}

/** A file to include first: @-mentioned by path, or a place in it (a named symbol, the selection). */
export type Mention = string | { path: string; line: number; end?: number; reason: string };

export interface Corpus {
  files: string[];
  text(path: string): string | undefined;
  outline(path: string): OutlineSymbol[];
  index: LexicalIndex;
  graph: FileGraph;
}

const STRATEGY = 'One file per role (implementation, test, docs), ranked by keyword, code-graph and existing-pattern signals; outlines and line-numbered snippets within the token budget. Read more with read_file, outline, find_symbol or search_code.';

const NOUNS = 'command|subcommand|endpoint|route|view|handler|function|method|class|option|flag|hook|filter|middleware|field|model|setting|plugin|extension|page|component|fixture|helper|decorator|signal|template|tool|api|validator|serializer|migration';
const ADD_PATTERN = new RegExp(`\\b(?:add|create|implement|introduce|write|build|register|define)\\s+(?:a|an|the)?\\s*(?:new\\s+)?((?:[\\w-]+\\s+){0,4}?)(${NOUNS})(?:s)?\\b`, 'i');

export const isTest = (p: string) => /(^|\/)(tests?|__tests__|spec)\//.test(p) || /(^|\/)test_[^/]+$|_test\.\w+$|\.(test|spec)\.\w+$/.test(p);
export const isDoc = (p: string) => /\.(md|rst|txt|adoc)$/i.test(p);
const isCode = (p: string) => /\.(py|js|mjs|cjs|ts|tsx|jsx|go|rs|java|rb|php|cs|kt|swift|c|cc|cpp|h)$/i.test(p);
const isExample = (p: string) => /(^|\/)(examples?|samples?|fixtures?|test_apps)\//.test(p);
const estimateTokens = (text: string) => Math.ceil(text.length / 4);

/** Nouns too generic to find "existing things of the same kind" by name. */
const GENERIC_NOUNS = new Set(['method', 'function', 'class', 'helper', 'field', 'tool', 'api']);

export interface Intent {
  terms: string[];
  roles: Role[];
  /** Identifiers the request names (`Config`, `get_debug_flag`); resolved against definitions. */
  identifiers: string[];
  /** Kind of thing being added ("command"), when the request says "add a new … X". */
  noun?: string;
  /** Words describing that thing ("built-in cli command"): matches on these are on-topic. */
  intentTerms: string[];
}

export function readIntent(request: string): Intent {
  const roles: Role[] = ['impl'];
  if (/\b(tests?|tested|testing|covered by|coverage|unit test|pytest)\b/i.test(request)) roles.push('test');
  if (/\b(docs?|document(ed|ation)?|readme|changelog)\b/i.test(request)) roles.push('docs');
  const m = ADD_PATTERN.exec(request);
  const found = m ? stem(m[2]!.toLowerCase()) : undefined;
  const noun = found && !GENERIC_NOUNS.has(found) ? found : undefined;
  // CamelCase (Config, MethodView), snake_case (get_debug_flag) or `backticked` names.
  const identifiers = [...new Set([...request.matchAll(/`([\w.]+)`|\b([A-Z][a-z]+[A-Za-z0-9]*|[a-z][a-z0-9]*_[a-z0-9_]+)\b/g)].map((x) => (x[1] ?? x[2])!.split('.').pop()!))];
  return {
    terms: [...new Set(tokenize(request))],
    roles,
    identifiers,
    intentTerms: m && noun ? [...new Set(tokenize(`${m[1]} ${m[2]}`))] : [],
    ...(noun ? { noun } : {}),
  };
}

interface Candidate { path: string; score: number; reasons: string[]; distractor?: string; siblings?: OutlineSymbol[]; pattern?: OutlineSymbol }

/** Ranked candidates per role (used by the recall evaluation and for transparency). */
export function rankRoles(corpus: Corpus, request: string): Record<Role, string[]> {
  const intent = readIntent(request);
  const impl = rankImpl(corpus, intent);
  const top = impl[0];
  return {
    impl: impl.slice(0, 5).map((c) => c.path),
    test: top ? rankTests(corpus, intent, top).slice(0, 5).map((c) => c.path) : [],
    docs: top ? rankDocs(corpus, intent, top).slice(0, 5).map((c) => c.path) : [],
  };
}

export function buildPack({ corpus, request, budget, mentions = [] }: { corpus: Corpus; request: string; budget: number; mentions?: Mention[] }): ContextPack {
  const intent = readIntent(request);
  const dropped: ContextPack['dropped'] = [];

  const impl = rankImpl(corpus, intent);
  for (const other of impl.slice(1, 4)) if (other.distractor) dropped.push({ path: other.path, reason: other.distractor });
  const implPath = impl[0]?.path;

  let test: Candidate | undefined;
  if (intent.roles.includes('test') && implPath) {
    const ranked = rankTests(corpus, intent, impl[0]!);
    test = ranked[0];
    for (const other of ranked.slice(1, 2)) dropped.push({ path: other.path, reason: `weaker test match than ${base(test?.path)}` });
  }
  let docs: Candidate | undefined;
  if (intent.roles.includes('docs') && implPath) {
    const ranked = rankDocs(corpus, intent, impl[0]!);
    docs = ranked[0];
    for (const other of ranked.slice(1, 3)) dropped.push({ path: other.path, reason: other.distractor ?? `weaker docs match than ${base(docs?.path)}` });
  }
  const related = implPath ? neighbours(corpus.graph, implPath, 6).filter((n) => n.file !== test?.path && !isTest(n.file) && !isDoc(n.file)).slice(0, 2) : [];

  // Generous snippets first; shrink them, then drop extras, then keep only headers and reasons.
  const levels: Array<Omit<RenderLevel, 'budget'>> = [
    { cap: 45, extras: true, bodies: true }, { cap: 30, extras: true, bodies: true }, { cap: 20, extras: true, bodies: true },
    { cap: 12, extras: true, bodies: true }, { cap: 6, extras: false, bodies: true }, { cap: 0, extras: false, bodies: false },
  ];
  let pack: ContextPack | undefined;
  for (const level of levels) {
    pack = render({ corpus, request, intent, mentions, impl: impl[0], test, docs, related, dropped, level: { ...level, budget } });
    if (pack.used <= budget) break;
  }
  return pack!;
}

interface RenderLevel { cap: number; extras: boolean; bodies: boolean; budget: number }

function rankImpl(corpus: Corpus, intent: Intent): Candidate[] {
  const out: Candidate[] = [];
  for (const path of corpus.files) {
    if (!isCode(path) || isTest(path)) continue;
    const s = corpus.index.score(path, intent.terms);
    const symbols = corpus.outline(path);
    const siblings = intent.noun ? siblingsOf(symbols, intent.noun) : [];
    const named = symbols.filter((sym) => sym.kind !== 'section' && sym.kind !== 'method' && intent.identifiers.includes(sym.name));
    const centrality = corpus.graph.rank.get(path) ?? 0;
    let score = 2 * s.path + s.symbols + 0.5 * s.body + (siblings.length ? 3 + 0.5 * Math.min(siblings.length, 4) : 0) + (named.length ? 4 : 0) + 0.3 * centrality;
    if (isExample(path)) score *= 0.4;
    const pathHits = [...s.matched.get('path')!];
    const reasons: string[] = [];
    if (named.length) reasons.push(`defines ${named.map((x) => x.name).join(', ')} (named in the request)`);
    if (pathHits.length) reasons.push(`path matches "${pathHits.join('", "')}"`);
    if (siblings.length) reasons.push(`defines ${siblings.slice(0, 3).map((x) => x.name).join(', ')}${siblings.length > 3 ? ` +${siblings.length - 3}` : ''} (same kind as the new ${intent.noun})`);
    const links = corpus.graph.links.get(path)?.size ?? 0;
    if (centrality > 0.5) reasons.push(`connected to ${links} other files`);
    if (!reasons.length && s.body > 0) reasons.push(`mentions "${[...s.matched.get('body')!].slice(0, 3).join('", "')}"`);

    let distractor: string | undefined;
    const onTopic = siblings.length > 0 || named.length > 0 || [...s.matched.get('path')!, ...s.matched.get('symbols')!].some((t) => intent.intentTerms.includes(t));
    if (intent.intentTerms.length && !onTopic) {
      score *= 0.5;
      const hits = [...new Set([...s.matched.get('path')!, ...s.matched.get('symbols')!, ...s.matched.get('body')!])].slice(0, 2);
      distractor = `matches only ${hits.length ? `"${hits.join('", "')}"` : 'loosely'}, not the ${intent.intentTerms.join(' ')} pattern`;
    }
    const pattern = siblings.length ? choosePattern(siblings, corpus.text(path) ?? '', intent.terms) : undefined;
    if (score > 0) out.push({ path, score, reasons, siblings, ...(pattern ? { pattern } : {}), ...(distractor ? { distractor } : {}) });
  }
  return out.sort((a, b) => b.score - a.score);
}

function rankTests(corpus: Corpus, intent: Intent, impl: Candidate): Candidate[] {
  const implStem = fileStem(impl.path);
  const siblingStems = siblingWords(impl, intent);
  const out: Candidate[] = [];
  for (const path of corpus.files) {
    if (!isTest(path) || !isCode(path) || isExample(path)) continue;
    const links = linkWeight(corpus.graph, path, impl.path);
    const named = fileStem(path).replace(/^test_|_test$|\.test$|\.spec$/, '') === implStem;
    const matched = [...new Set(siblingStems.flatMap((w) => corpus.outline(path).filter((s) => hasWord(s.name, w))))];
    const focus = choosePattern(matched.filter((s) => s.kind !== 'method'), corpus.text(path) ?? '', intent.terms);
    const covers = focus ? [focus, ...matched.filter((s) => s !== focus)] : matched;
    const s = corpus.index.score(path, intent.terms);
    const score = Math.min(links / 10, 2) + (named ? 2 : 0) + Math.min(covers.length, 3) * 0.7 + 0.2 * (s.path + s.symbols + s.body);
    const reasons: string[] = [];
    if (named) reasons.push(`test file for ${base(impl.path)}`);
    if (links) reasons.push(`calls or imports ${base(impl.path)}`);
    if (covers.length) reasons.push(`has ${covers.slice(0, 2).map((c) => c.name).join(', ')} to follow`);
    if (score > 0) out.push({ path, score, reasons, siblings: covers });
  }
  return out.sort((a, b) => b.score - a.score);
}

function rankDocs(corpus: Corpus, intent: Intent, impl: Candidate): Candidate[] {
  const implStem = fileStem(impl.path);
  const siblingStems = siblingWords(impl, intent);
  const out: Candidate[] = [];
  for (const path of corpus.files) {
    if (!isDoc(path) || /(^|\/)(changes|changelog|license)/i.test(path)) continue;
    const text = corpus.text(path) ?? '';
    const lower = text.toLowerCase();
    const pathMatch = tokenize(fileStem(path)).includes(implStem);
    const words = new Set(tokenize(lower));
    const mentioned = siblingStems.filter((w) => words.has(w));
    const s = corpus.index.score(path, intent.terms);
    const score = (pathMatch ? 3 : 0) + mentioned.length * 0.8 + 0.3 * s.body + 0.5 * s.path;
    const reasons: string[] = [];
    if (pathMatch) reasons.push(`docs page for ${base(impl.path)}`);
    if (mentioned.length) reasons.push(`documents ${mentioned.slice(0, 3).join(', ')}`);
    if (!reasons.length && s.body) reasons.push(`mentions "${[...s.matched.get('body')!].slice(0, 2).join('", "')}"`);
    const distractor = !pathMatch && !mentioned.length ? `matches only ${[...s.matched.get('path')!, ...s.matched.get('body')!].slice(0, 2).map((t) => `"${t}"`).join(', ') || 'loosely'}, not ${base(impl.path)}` : undefined;
    if (score > 0) out.push({ path, score, reasons, ...(distractor ? { distractor } : {}) });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** Existing things of the same kind: top-level `x_command` defs first, other name matches only as a fallback. */
function siblingsOf(symbols: OutlineSymbol[], noun: string): OutlineSymbol[] {
  const named = symbols.filter((s) => s.kind !== 'section' && tokenize(s.name).includes(noun));
  const strong = named.filter((s) => s.kind !== 'method' && tokenize(s.name).at(-1) === noun && tokenize(s.name).length > 1);
  return strong.length ? strong : named;
}

/** The sibling to show as the pattern (chosen in rankImpl), else the first one. */
function patternOf(impl: Candidate): OutlineSymbol | undefined {
  return impl.pattern ?? impl.siblings?.[0];
}

/** Sibling whose body shares the most request words per line: the closest template to copy. */
function choosePattern(siblings: OutlineSymbol[], text: string, terms: string[]): OutlineSymbol | undefined {
  const lines = text.split('\n');
  const wanted = new Set(terms);
  let best: { s: OutlineSymbol; score: number } | undefined;
  for (const s of siblings) {
    const body = new Set(tokenize(lines.slice(s.line - 1, s.endLine).join('\n')));
    const overlap = [...wanted].filter((t) => body.has(t)).length;
    const score = overlap / Math.sqrt(Math.max(s.endLine - s.line + 1, 1));
    if (!best || score > best.score) best = { s, score };
  }
  return best?.s;
}

/** "routes_command" → "route" for noun "command"; the pattern's word first. Used to pick tests and docs. */
function siblingWords(impl: Candidate, intent: Intent): string[] {
  const pattern = patternOf(impl);
  const ordered = [pattern, ...(impl.siblings ?? [])].filter((s): s is OutlineSymbol => Boolean(s));
  const words = ordered.flatMap((s) => tokenize(s.name).filter((t) => t !== intent.noun));
  return [...new Set(words)].filter((w) => w.length > 2).slice(0, 8);
}

/** Whole-token match, so "run" matches test_run_cert but not "runner". */
const hasWord = (name: string, word: string) => tokenize(name).includes(word);

// ---- rendering ---------------------------------------------------------------------------------

function render({ corpus, request, intent, mentions, impl, test, docs, related, dropped, level }: {
  corpus: Corpus; request: string; intent: Intent; mentions: Mention[]; impl?: Candidate; test?: Candidate; docs?: Candidate;
  related: Array<{ file: string; weight: number }>; dropped: ContextPack['dropped']; level: RenderLevel;
}): ContextPack {
  const { cap, extras, bodies, budget } = level;
  const items: PackItem[] = [];
  const blocks: string[] = [`Context pack from Anvil. ${STRATEGY}`];
  const push = (kind: ItemKind, path: string, score: number, reasons: string[], body: () => string) => {
    const block = `\n[${label(kind)}] ${path}${reasons.length ? ` (${reasons.join('; ')})` : ''}\n${bodies ? body() : ''}`.trimEnd();
    blocks.push(block);
    items.push({ kind, path, score: round(score), reasons, tokens: estimateTokens(block) });
  };

  for (const mention of mentions) {
    const path = typeof mention === 'string' ? mention : mention.path;
    const text = corpus.text(path);
    if (text === undefined) continue;
    // A named definition or a selection is shown from its own line, not from the top of the file.
    const from = typeof mention === 'string' ? 1 : Math.max(1, mention.line - 2);
    const reason = typeof mention === 'string' ? 'you mentioned it' : mention.reason;
    const to = typeof mention !== 'string' && mention.end ? Math.min(mention.end + 2, from + 149) : from + Math.min(cap * 3, 150) - 1;
    push('mention', path, 1, [reason], () => numbered(text, from, to));
  }
  if (impl) push('impl', impl.path, impl.score, impl.reasons, () => implBody(corpus, impl, intent, cap));
  if (test) push('test', test.path, test.score, test.reasons, () => focusBody(corpus, test, cap));
  if (docs) push('docs', docs.path, docs.score, docs.reasons, () => docsBody(corpus, docs, impl, intent, cap));
  if (extras) {
    for (const r of related) push('related', r.file, r.weight, [`linked to ${base(impl?.path)} in the code`], () => '');
    if (dropped.length) blocks.push(`\nNot included: ${dropped.map((d) => `${d.path} (${d.reason})`).join('; ')}.`);
  }
  const targets = items.filter((i) => i.kind === 'impl' || i.kind === 'test' || i.kind === 'docs').map((i) => i.path);
  blocks.push(`\nTask (repeated): ${request.trim()}${targets.length ? `\nLikely files to change: ${targets.join(', ')}` : ''}`);

  const text = blocks.join('\n');
  return { strategy: STRATEGY, budget, used: estimateTokens(text), roles: intent.roles, items, dropped, text };
}

function implBody(corpus: Corpus, impl: Candidate, intent: Intent, cap: number): string {
  const text = corpus.text(impl.path) ?? '';
  const symbols = corpus.outline(impl.path).filter((s) => s.kind !== 'method');
  const parts = [`Outline:\n${symbols.slice(0, cap).map((s) => `  L${s.line} ${s.signature}`).join('\n')}`];
  const siblings = impl.siblings ?? [];
  if (siblings.length) {
    const pattern = patternOf(impl)!;
    parts.push(`Existing ${intent.noun} to follow (${pattern.name}):\n${clipped(text, pattern.line, pattern.endLine, cap)}`);
    const names = new Set(siblings.map((s) => s.name));
    const lines = text.split('\n');
    const uses = lines
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line, n }) => [...names].some((name) => line.includes(name)) && !siblings.some((s) => n >= s.line && n <= s.endLine))
      .slice(0, 6);
    if (uses.length) parts.push(`Where existing ${intent.noun}s are registered:\n${uses.map(({ line, n }) => `${n}│${line}`).join('\n')}`);
  }
  return parts.join('\n');
}

function focusBody(corpus: Corpus, item: Candidate, cap: number): string {
  const text = corpus.text(item.path) ?? '';
  const focus = item.siblings?.[0];
  if (focus) {
    // New tests usually go at the end of the file: give the agent that anchor too.
    const last = text.replace(/\s+$/, '').split('\n').length;
    const end = focus.endLine < last - 2 ? `\nEnd of file:\n${numbered(text, last - 2, last)}` : '';
    return `${focus.name} (pattern to follow):\n${clipped(text, focus.line, focus.endLine, cap)}${end}`;
  }
  return `Outline:\n${corpus.outline(item.path).slice(0, cap).map((s) => `  L${s.line} ${s.signature}`).join('\n')}`;
}

function docsBody(corpus: Corpus, docs: Candidate, impl: Candidate | undefined, intent: Intent, cap: number): string {
  const text = corpus.text(docs.path) ?? '';
  const words = impl ? siblingWords(impl, intent) : intent.terms;
  const sections = corpus.outline(docs.path);
  const lines = text.split('\n');
  const best = sections
    .map((s) => {
      const body = new Set(tokenize(lines.slice(s.line - 1, s.endLine).join('\n')));
      const heading = new Set(tokenize(s.name));
      // The pattern's word counts most; a heading match beats a body mention.
      const hits = words.reduce((n, w, i) => n + (heading.has(w) ? 3 : body.has(w) ? 1 : 0) / (i + 1), 0);
      return { s, hits };
    })
    .sort((a, b) => b.hits - a.hits)[0];
  const headings = `Sections: ${sections.map((s) => `${s.name} (L${s.line})`).slice(0, 12).join(', ')}`;
  if (!best || best.hits === 0) return headings;
  return `${headings}\nSection "${best.s.name}":\n${clipped(text, best.s.line, best.s.endLine, cap)}`;
}

/** Lines from–end, at most `cap`; a clipped block keeps its last lines so edits can anchor on its end. */
function clipped(text: string, from: number, end: number, cap: number): string {
  if (end - from + 1 <= cap || cap < 8) return numbered(text, from, Math.min(end, from + cap - 1));
  return `${numbered(text, from, from + cap - 4)}\n   …\n${numbered(text, end - 2, end)}`;
}

function numbered(text: string, from: number, to: number): string {
  const lines = text.split('\n');
  return lines.slice(from - 1, to).map((l, i) => `${from + i}│${l}`).join('\n');
}

function label(kind: ItemKind): string {
  return { impl: 'implementation', test: 'test', docs: 'docs', mention: 'mentioned', related: 'related' }[kind];
}

const fileStem = (p: string) => (p.split('/').pop() ?? p).replace(/\.[^.]+$/, '').toLowerCase();
const base = (p?: string) => (p ?? '').split('/').pop() ?? '';
const round = (n: number) => Math.round(n * 100) / 100;
