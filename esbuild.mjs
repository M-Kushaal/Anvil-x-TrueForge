// Bundles the extension host (Node, CJS) and the chat webview (browser, IIFE + CSS + codicon font).
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const shared = { bundle: true, sourcemap: !production, minify: production, logLevel: 'info' };

const builds = [
  {
    ...shared,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['vscode'],
  },
  {
    ...shared,
    entryPoints: { webview: 'webview/main.tsx' },
    outdir: 'dist',
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    jsx: 'automatic',
    jsxImportSource: 'preact',
    loader: { '.ttf': 'file' },
    assetNames: '[name]',
  },
];

if (watch) {
  for (const options of builds) await (await esbuild.context(options)).watch();
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
}
