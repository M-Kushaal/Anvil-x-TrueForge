// Mocha entry point loaded inside the VS Code extension host.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import Mocha from 'mocha';
import { registerReviewTests } from './review.e2e';

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', timeout: 30_000, color: false });
  mocha.suite.emit('pre-require', globalThis, 'anvil-e2e', mocha);
  registerReviewTests();
  return new Promise((resolve, reject) => {
    const runner = mocha.run((failures) => {
      // The launcher checks this file, so a suite that never started cannot pass silently.
      const summary = `e2e: ${runner.stats?.passes ?? 0} passing, ${failures} failing`;
      writeFileSync(path.join(process.env.ANVIL_E2E_WORKSPACE ?? '.', 'e2e-result.txt'), summary);
      if (failures) reject(new Error(`${failures} e2e test(s) failed`));
      else resolve();
    });
  });
}
