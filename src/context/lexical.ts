// Keyword index: BM25 per field (path, symbol names, body) over every text file. Identifiers are
// split (`get_debug_flag`, `getDebugFlag` → get, debug, flag) and plurals folded. Pure.

const STOP = new Set(('a an and are as at be by can do does for from has have how i if in into is it its of on or that the then '
  + 'this to was we what when where which will with you your should must any every also other new add make use using it\'s '
  + 'py src lib test tests self none true false return def class import').split(' '));

export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP.has(t) && !/^\d+$/.test(t))
    .map(stem);
}

/** Folds simple plurals so "commands" matches "command". */
export function stem(token: string): string {
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

export type Field = 'path' | 'symbols' | 'body';
export interface FieldScores { path: number; symbols: number; body: number; matched: Map<Field, Set<string>> }

interface Doc { path: string; tf: Record<Field, Map<string, number>>; len: Record<Field, number> }

export class LexicalIndex {
  private docs = new Map<string, Doc>();
  private df: Record<Field, Map<string, number>> = { path: new Map(), symbols: new Map(), body: new Map() };
  private totalLen: Record<Field, number> = { path: 0, symbols: 0, body: 0 };

  set(path: string, { symbols, body }: { symbols: string[]; body: string }): void {
    this.remove(path);
    const fields: Record<Field, string[]> = { path: tokenize(path.replace(/\.[^./]+$/, '')), symbols: symbols.flatMap(tokenize), body: tokenize(body) };
    const doc: Doc = { path, tf: { path: new Map(), symbols: new Map(), body: new Map() }, len: { path: 0, symbols: 0, body: 0 } };
    for (const field of Object.keys(fields) as Field[]) {
      for (const t of fields[field]) doc.tf[field].set(t, (doc.tf[field].get(t) ?? 0) + 1);
      doc.len[field] = fields[field].length;
      this.totalLen[field] += doc.len[field];
      for (const t of doc.tf[field].keys()) this.df[field].set(t, (this.df[field].get(t) ?? 0) + 1);
    }
    this.docs.set(path, doc);
  }

  remove(path: string): void {
    const doc = this.docs.get(path);
    if (!doc) return;
    for (const field of Object.keys(doc.tf) as Field[]) {
      this.totalLen[field] -= doc.len[field];
      for (const t of doc.tf[field].keys()) this.df[field].set(t, (this.df[field].get(t) ?? 1) - 1);
    }
    this.docs.delete(path);
  }

  /** BM25 per field for one document. Body term frequency is log-damped so long files don't win on volume. */
  score(path: string, terms: string[]): FieldScores {
    const doc = this.docs.get(path);
    const matched = new Map<Field, Set<string>>([['path', new Set()], ['symbols', new Set()], ['body', new Set()]]);
    const out: FieldScores = { path: 0, symbols: 0, body: 0, matched };
    if (!doc) return out;
    const n = this.docs.size;
    for (const field of ['path', 'symbols', 'body'] as Field[]) {
      const avg = this.totalLen[field] / Math.max(n, 1) || 1;
      for (const t of new Set(terms)) {
        const raw = doc.tf[field].get(t);
        if (!raw) continue;
        const tf = field === 'body' ? 1 + Math.log(raw) : raw;
        const df = this.df[field].get(t) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        const k1 = 1.2;
        const b = field === 'body' ? 0.75 : 0.3;
        out[field] += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (doc.len[field] / avg))));
        matched.get(field)!.add(t);
      }
    }
    return out;
  }
}
