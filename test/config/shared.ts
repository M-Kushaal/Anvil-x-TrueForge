import path from 'node:path';
import { defineConfig } from 'vitest/config';

export const sharedConfig = defineConfig({
  root: path.resolve(import.meta.dirname, '../..'),
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  test: { environment: 'node' },
});
