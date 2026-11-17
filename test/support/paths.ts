import path from 'node:path';

export const projectRoot = path.resolve(import.meta.dirname, '../..');
export const flaskRoot = path.resolve(projectRoot, process.env.FLASK_DIR ?? '../flask');
export const pythonCommand = process.env.PYTHON_BIN ?? 'python';

export function fixturePath(...segments: string[]): string {
  return path.join(projectRoot, 'test', 'fixtures', ...segments);
}
