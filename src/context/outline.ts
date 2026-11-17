// Fast, dependency-free symbol outline with line ranges. Python uses indentation to find where a
// definition ends; JS/TS uses brace depth. Docs (.md/.rst) are split into heading sections.

export interface OutlineSymbol {
  name: string;
  kind: 'class' | 'function' | 'method' | 'section';
  /** 1-based, inclusive; `line` includes leading decorators. */
  line: number;
  endLine: number;
  /** Signature line(s) without the body. */
  signature: string;
  parent?: string;
}

export function outline(path: string, text: string): OutlineSymbol[] {
  if (/\.py$/i.test(path)) return pythonOutline(text);
  if (/\.(m|c)?[jt]sx?$/i.test(path)) return braceOutline(text);
  if (/\.(md|rst|txt)$/i.test(path)) return docSections(path, text);
  return [];
}

function pythonOutline(text: string): OutlineSymbol[] {
  const lines = text.split('\n');
  const out: OutlineSymbol[] = [];
  const stack: Array<{ indent: number; name: string }> = [];
  lines.forEach((line, i) => {
    const m = /^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/.exec(line);
    if (!m) return;
    const indent = m[1]!.length;
    while (stack.length && stack.at(-1)!.indent >= indent) stack.pop();
    let start = i;
    while (start > 0 && /^\s*@/.test(lines[start - 1]!)) start--;
    const end = blockEnd(lines, i, indent);
    const parent = stack.at(-1)?.name;
    const kind = m[2] === 'class' ? 'class' : parent ? 'method' : 'function';
    out.push({ name: m[3]!, kind, line: start + 1, endLine: end + 1, signature: signatureFrom(lines, i), ...(parent ? { parent } : {}) });
    stack.push({ indent, name: m[3]! });
  });
  return out;
}

/** Last line of an indented block that starts at `start` with indentation `indent`. */
function blockEnd(lines: string[], start: number, indent: number): number {
  let end = start;
  for (let j = start + 1; j < lines.length; j++) {
    const l = lines[j]!;
    if (!l.trim()) continue;
    if (l.length - l.trimStart().length <= indent) break;
    end = j;
  }
  return end;
}

function signatureFrom(lines: string[], i: number): string {
  let sig = lines[i]!.trim();
  for (let j = i + 1; !/[:{]\s*(#.*)?$/.test(sig) && j < Math.min(lines.length, i + 6); j++) sig += ` ${lines[j]!.trim()}`;
  return sig.length > 160 ? `${sig.slice(0, 159)}…` : sig;
}

function braceOutline(text: string): OutlineSymbol[] {
  const lines = text.split('\n');
  const out: OutlineSymbol[] = [];
  const pattern = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:(class)\s+([A-Za-z_$][\w$]*)|function\*?\s+([A-Za-z_$][\w$]*)|(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>)/;
  lines.forEach((line, i) => {
    const m = pattern.exec(line);
    if (!m) return;
    const name = m[2] ?? m[3] ?? m[4]!;
    let depth = 0;
    let end = i;
    let opened = false;
    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j]!) {
        if (ch === '{') { depth++; opened = true; }
        else if (ch === '}') depth--;
      }
      end = j;
      if (opened && depth <= 0) break;
      if (!opened && j > i + 2) break;
    }
    out.push({ name, kind: m[1] ? 'class' : 'function', line: i + 1, endLine: end + 1, signature: signatureFrom(lines, i) });
  });
  return out;
}

function docSections(path: string, text: string): OutlineSymbol[] {
  const lines = text.split('\n');
  const heads: Array<{ name: string; line: number }> = [];
  lines.forEach((line, i) => {
    const md = /^#{1,6}\s+(.+)/.exec(line);
    if (md && path.endsWith('.md')) heads.push({ name: md[1]!.trim(), line: i + 1 });
    // RST: a title line followed by an underline of =, -, ~, ^ at least as long.
    const next = lines[i + 1] ?? '';
    if (line.trim() && /^([=\-~^"'`#*+])\1{2,}\s*$/.test(next) && next.trim().length >= line.trim().length) heads.push({ name: line.trim(), line: i + 1 });
  });
  return heads.map((h, k) => ({
    name: h.name,
    kind: 'section' as const,
    line: h.line,
    endLine: (heads[k + 1]?.line ?? lines.length + 1) - 1,
    signature: h.name,
  }));
}
