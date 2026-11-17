import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  test: {
    include: ['test/unit/**/*.test.ts', 'test/webview/**/*.test.tsx'],
    environment: 'node',
  },
});
