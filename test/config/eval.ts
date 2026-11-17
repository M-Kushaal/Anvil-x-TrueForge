// Retrieval evaluation on the pinned Flask checkout. Not part of `npm test`.
import { mergeConfig } from 'vitest/config';
import { sharedConfig } from './shared';

export default mergeConfig(sharedConfig, {
  test: { include: ['test/eval/**/*.test.ts'], testTimeout: 120_000 },
});
