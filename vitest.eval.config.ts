// Retrieval evaluation on the pinned Flask checkout. Not part of `npm test`.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['test/eval/**/*.test.ts'], environment: 'node', testTimeout: 120_000 },
});
