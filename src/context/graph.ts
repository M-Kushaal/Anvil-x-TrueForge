// File-level code graph from Graphify's graph.json (AST only, no LLM): weighted links between
// files (calls, imports, references, inherits) and PageRank centrality. Pure.

export interface FileGraph {
  /** Undirected weighted adjacency between workspace files. */
  links: Map<string, Map<string, number>>;
  /** PageRank, normalised so the most central file is 1. */
  rank: Map<string, number>;
}

interface GraphifyNode { id: string; label?: string; source_file?: string }
interface GraphifyLink { source: string; target: string; relation?: string; weight?: number }

const RELATION_WEIGHT: Record<string, number> = {
  calls: 1, indirect_call: 0.5, imports_from: 1, imports: 0.5, references: 0.5, uses: 0.5, inherits: 1.5, re_exports: 0.5,
};

export function emptyGraph(): FileGraph {
  return { links: new Map(), rank: new Map() };
}

export function parseGraphify(json: { nodes?: GraphifyNode[]; links?: GraphifyLink[]; edges?: GraphifyLink[] }): FileGraph {
  const fileOf = new Map<string, string>();
  for (const node of json.nodes ?? []) if (node.source_file) fileOf.set(node.id, node.source_file.replace(/\\/g, '/'));
  const links = new Map<string, Map<string, number>>();
  const add = (a: string, b: string, w: number) => {
    const row = links.get(a) ?? links.set(a, new Map()).get(a)!;
    row.set(b, (row.get(b) ?? 0) + w);
  };
  for (const link of json.links ?? json.edges ?? []) {
    const a = fileOf.get(link.source);
    const b = fileOf.get(link.target);
    const w = RELATION_WEIGHT[link.relation ?? ''] ?? 0;
    if (!a || !b || a === b || w === 0) continue;
    add(a, b, w);
    add(b, a, w);
  }
  return { links, rank: pageRank(links) };
}

/** Neighbours of `file`, strongest first. */
export function neighbours(graph: FileGraph, file: string, limit = 8): Array<{ file: string; weight: number }> {
  return [...(graph.links.get(file) ?? [])].map(([f, weight]) => ({ file: f, weight })).sort((a, b) => b.weight - a.weight).slice(0, limit);
}

export function linkWeight(graph: FileGraph, a: string, b: string): number {
  return graph.links.get(a)?.get(b) ?? 0;
}

function pageRank(links: Map<string, Map<string, number>>, damping = 0.85, iterations = 30): Map<string, number> {
  const nodes = [...links.keys()];
  if (nodes.length === 0) return new Map();
  let rank = new Map(nodes.map((n) => [n, 1 / nodes.length]));
  const outWeight = new Map(nodes.map((n) => [n, [...links.get(n)!.values()].reduce((s, w) => s + w, 0)]));
  for (let it = 0; it < iterations; it++) {
    const next = new Map(nodes.map((n) => [n, (1 - damping) / nodes.length]));
    for (const n of nodes) {
      const share = (rank.get(n) ?? 0) * damping;
      const total = outWeight.get(n) || 1;
      for (const [m, w] of links.get(n)!) next.set(m, (next.get(m) ?? 0) + share * (w / total));
    }
    rank = next;
  }
  const max = Math.max(...rank.values());
  return new Map([...rank].map(([n, r]) => [n, r / max]));
}
