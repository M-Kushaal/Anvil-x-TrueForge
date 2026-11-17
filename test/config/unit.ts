import { mergeConfig } from 'vitest/config';
import { sharedConfig } from './shared';

export default mergeConfig(sharedConfig, {
  test: {
    include: ['test/unit/**/*.test.ts', 'test/webview/**/*.test.tsx'],
  },
});
