// Live tests need `npm run forge` running and a configured model. Not part of `npm test`.
import { mergeConfig } from 'vitest/config';
import { sharedConfig } from './shared';

export default mergeConfig(sharedConfig, {
  test: {
    include: ['test/live/**/*.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
