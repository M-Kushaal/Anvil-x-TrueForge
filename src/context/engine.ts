// Keeps the context indexes for a workspace: file texts, symbol outlines, BM25, and the Graphify
// code graph. Builds context packs and answers the symbol/outline/related tools.
import { isIndexablePath, type Workspace } from '../workspace/workspace';
import { emptyGraph, neighbours, type FileGraph } from './graph';
import { LexicalIndex } from './lexical';
import { outline, type OutlineSymbol } from './outline';
import { buildPack, isDoc, isTest, rankRoles, type ContextPack, type Corpus, type Mention, type Role } from './pack';

const MAX_FILES = 6000;
const MAX_BYTES = 400_000;

export interface SymbolHit extends OutlineSymbol { path: string }

export class ContextEngine {
  private texts = new Map<string, string>();
  private outlines = new Map<string, OutlineSymbol[]>();
  private index = new LexicalIndex();
  private graph: FileGraph = emptyGraph();
  private ready: Promise<void> | undefined;
  private dirty = new Set<string>();
  private versions = new Map<string, number>();
  private preparing: Promise<void> | undefined;
  graphSource: 'graphify' | 'none' = 'none';

  constructor(private readonly ws: Workspace) {}

  build(): Promise<void> {
    this.ready ??= (async () => {
      // Over the cap, keep code first, then tests, then docs, so a large repo never loses src/.
      const rank = (p: string) => (isTest(p) ? 1 : isDoc(p) ? 2 : /\.(json|ya?ml|toml|lock|txt|csv|svg|map)$/i.test(p) ? 3 : 0);
      const files = (await this.ws.files()).sort((a, b) => rank(a) - rank(b)).slice(0, MAX_FILES);
      await forEachBounded(files, (p) => this.refresh(p));
    })();
    return this.ready;
  }

  setGraph(graph: FileGraph): void {
    this.graph = graph;
    this.graphSource = graph.links.size ? 'graphify' : 'none';
  }

  /** Re-index one file after a save (or a create/delete). */
  async refresh(path: string): Promise<void> {
    path = path.replace(/\\/g, '/').replace(/^\.\//, '');
    const version = (this.versions.get(path) ?? 0) + 1;
    this.versions.set(path, version);
    this.index.remove(path);
    this.texts.delete(path);
    this.outlines.delete(path);
    if (!isIndexablePath(path)) return;
    const text = await this.ws.read(path).catch(() => undefined);
    // A slower read must never overwrite a newer buffer or a deletion.
    if (this.versions.get(path) !== version || text === undefined || text.length > MAX_BYTES) return;
    if (!this.texts.has(path) && this.texts.size >= MAX_FILES) return;
    const symbols = outline(path, text);
    this.texts.set(path, text);
    this.outlines.set(path, symbols);
    this.index.set(path, { symbols: symbols.map((s) => s.name), body: text });
  }

  /** Coalesces editor, draft and filesystem changes until the next retrieval request. */
  invalidate(path: string): void {
    const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '');
    if (isIndexablePath(normalized)) this.dirty.add(normalized);
  }

  /** Call before resolving mentions or symbols so they use the same fresh corpus as the pack. */
  async prepare(): Promise<void> {
    await this.build();
    this.preparing ??= (async () => {
      while (this.dirty.size) {
        const paths = [...this.dirty];
        this.dirty.clear();
        await forEachBounded(paths, (p) => this.refresh(p));
      }
    })().finally(() => { this.preparing = undefined; });
    await this.preparing;
  }

  get fileCount(): number {
    return this.texts.size;
  }

  async pack(request: string, { budget, mentions = [], exclude = [], resolveExplicitMentions = false }: { budget: number; mentions?: Mention[]; exclude?: string[]; resolveExplicitMentions?: boolean }): Promise<ContextPack> {
    await this.prepare();
    const requested = resolveExplicitMentions ? [...this.resolveMentions(request), ...mentions] : mentions;
    const uniqueMentions = new Map<string, Mention>();
    for (const mention of requested) {
      const path = normalizePath(typeof mention === 'string' ? mention : mention.path);
      if (!uniqueMentions.has(path)) uniqueMentions.set(path, mention);
    }
    const excluded = exclude.map(normalizePath);
    const allowed = (p: string) => !excluded.some((entry) => p === entry || p.startsWith(`${entry}/`));
    return buildPack({ corpus: this.corpus(allowed), request, budget,
      mentions: [...uniqueMentions.values()].filter((mention) => allowed(normalizePath(typeof mention === 'string' ? mention : mention.path))) });
  }

  /** Ranked candidates per role (used by the retrieval evaluation). */
  async rank(request: string): Promise<Record<Role, string[]>> {
    await this.prepare();
    return rankRoles(this.corpus(), request);
  }

  /** `@path`, `@file.py` (unique suffix) or `@symbol` mentions in a request → files (and definitions). */
  resolveMentions(request: string): Mention[] {
    const out: Mention[] = [];
    const seen = new Set<string>();
    for (const [, raw] of request.matchAll(/(?:^|\s)@([\w./\\-]+)/g)) {
      const token = raw!.replace(/\\/g, '/').replace(/[.,;:]$/, '');
      const files = [...this.texts.keys()];
      const file = files.find((f) => f === token) ?? unique(files.filter((f) => f.endsWith(`/${token}`) || f === token));
      const symbol = file ? undefined : this.findSymbol(token).hits[0];
      const mention: Mention | undefined = file ?? (symbol && { path: symbol.path, line: symbol.line, reason: `you mentioned ${symbol.name}` });
      const path = typeof mention === 'string' ? mention : mention?.path;
      if (mention && path && !seen.has(path)) {
        seen.add(path);
        out.push(mention);
      }
    }
    return out;
  }

  outlineOf(path: string): OutlineSymbol[] {
    return this.outlines.get(path) ?? [];
  }

  /** Exact name first, then case-insensitive, then near misses ("did you mean"). */
  findSymbol(name: string): { hits: SymbolHit[]; suggestions: string[] } {
    const wanted = name.replace(/\(\)$/, '').split('.').pop() ?? name;
    const all: SymbolHit[] = [];
    for (const [path, symbols] of this.outlines) for (const s of symbols) if (s.kind !== 'section') all.push({ ...s, path });
    const exact = all.filter((s) => s.name === wanted);
    if (exact.length) return { hits: exact, suggestions: [] };
    const loose = all.filter((s) => s.name.toLowerCase() === wanted.toLowerCase());
    if (loose.length) return { hits: loose, suggestions: [] };
    const near = [...new Set(all.map((s) => s.name))]
      .map((n) => ({ n, d: distance(n.toLowerCase(), wanted.toLowerCase()) }))
      .filter(({ n, d }) => d <= Math.max(2, Math.floor(wanted.length / 4)) || n.toLowerCase().includes(wanted.toLowerCase()))
      .sort((a, b) => a.d - b.d)
      .slice(0, 5)
      .map(({ n }) => n);
    return { hits: [], suggestions: near };
  }

  /** Graph neighbours plus the conventional test and docs partners of a file. */
  related(path: string): Array<{ path: string; reason: string }> {
    const out = neighbours(this.graph, path, 8).map((n) => ({ path: n.file, reason: `linked in the code (${Math.round(n.weight)} references)` }));
    const stem = (path.split('/').pop() ?? '').replace(/\.[^.]+$/, '');
    for (const f of this.texts.keys()) {
      if (f === path || out.some((o) => o.path === f)) continue;
      const fstem = (f.split('/').pop() ?? '').replace(/\.[^.]+$/, '');
      if (isTest(f) && fstem.replace(/^test_|_test$/, '') === stem) out.push({ path: f, reason: 'test file by name' });
      else if (isDoc(f) && fstem === stem) out.push({ path: f, reason: 'docs page by name' });
    }
    return out;
  }

  private corpus(allowed: (path: string) => boolean = () => true): Corpus {
    const files = [...this.texts.keys()].filter(allowed);
    const included = new Set(files);
    return {
      files,
      text: (p) => included.has(p) ? this.texts.get(p) : undefined,
      outline: (p) => included.has(p) ? this.outlines.get(p) ?? [] : [],
      index: this.index,
      graph: {
        links: new Map([...this.graph.links].filter(([p]) => included.has(p))
          .map(([p, links]) => [p, new Map([...links].filter(([related]) => included.has(related)))])),
        rank: new Map([...this.graph.rank].filter(([p]) => included.has(p))),
      },
    };
  }

}

const normalizePath = (path: string): string => path.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');

async function forEachBounded<T>(items: T[], work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, items.length) }, async () => {
    while (next < items.length) await work(items[next++]!);
  }));
}

const unique = <T>(list: T[]): T | undefined => (list.length === 1 ? list[0] : undefined);

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length]!;
}
