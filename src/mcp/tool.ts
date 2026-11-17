// Tool contract independent of the MCP transport, so handlers stay unit-testable.
import { z } from 'zod';

export interface Tool {
  name: string;
  description: string;
  input: z.ZodRawShape;
  /** MCP annotations; TrueForge's `@write`/`@destructive` approval selectors read these. */
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean };
  /** Returns text whose first line is a short human-readable summary. */
  run(args: unknown): Promise<string>;
}

export function defineTool<S extends z.ZodRawShape>(def: {
  name: string;
  description: string;
  input: S;
  annotations: Tool['annotations'];
  run: (args: z.infer<z.ZodObject<S>>) => Promise<string>;
}): Tool {
  const schema = z.object(def.input);
  return {
    ...def,
    async run(args) {
      const parsed = schema.safeParse(args ?? {});
      if (!parsed.success) return `Error: invalid arguments for ${def.name}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`;
      try {
        return await def.run(parsed.data);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return message.startsWith('Error') ? message : `Error: ${message}`;
      }
    },
  };
}
