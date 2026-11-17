// Code-navigation tools backed by the context engine: symbol lookup with "did you mean",
// outlines with line ranges, and related files (code graph + test/docs partners).
import { z } from 'zod';
import type { ContextEngine } from '../context/engine';
import { plural } from '../shared/text';
import { defineTool, type Tool } from './tool';

export function contextTools(engine: ContextEngine): Tool[] {
  return [
    defineTool({
      name: 'find_symbol',
      description: 'Find where a function, method or class is defined. Returns file, line range and signature, or close matches if the name does not exist.',
      input: { name: z.string().describe('Symbol name, e.g. parse_args or UserService') },
      annotations: { readOnlyHint: true },
      run: async ({ name }) => {
        await engine.prepare();
        const { hits, suggestions } = engine.findSymbol(name);
        if (!hits.length) {
          return `${name} · not found${suggestions.length ? `\nDid you mean: ${suggestions.join(', ')}?` : '\nTry search_code instead.'}`;
        }
        return [`${name} · ${plural(hits.length, 'definition')}`, ...hits.slice(0, 10).map((h) => `${h.path}:${h.line}-${h.endLine}  ${h.signature}`)].join('\n');
      },
    }),
    defineTool({
      name: 'outline',
      description: 'List the classes, functions and methods of a file (or sections of a doc) with line ranges, without reading the whole file.',
      input: { path: z.string() },
      annotations: { readOnlyHint: true },
      run: async ({ path }) => {
        await engine.prepare();
        const symbols = engine.outlineOf(path);
        if (!symbols.length) return `${path} · no outline (unsupported type or empty). Use read_file.`;
        return [`${path} · ${symbols.length} symbols`, ...symbols.slice(0, 150).map((s) => `${s.parent ? '    ' : ''}L${s.line}-${s.endLine} ${s.signature}`)].join('\n');
      },
    }),
    defineTool({
      name: 'related_files',
      description: 'Files related to a file: code-graph neighbours (calls, imports, inheritance) and its test and docs partners, each with the reason.',
      input: { path: z.string() },
      annotations: { readOnlyHint: true },
      run: async ({ path }) => {
        await engine.prepare();
        const related = engine.related(path);
        if (!related.length) return `${path} · no related files found`;
        return [`${path} · ${related.length} related`, ...related.map((r) => `${r.path}  (${r.reason})`)].join('\n');
      },
    }),
  ];
}
