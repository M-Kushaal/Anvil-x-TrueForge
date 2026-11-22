/** One-use local execution grants. Stopping or switching tasks revokes every grant. */
export class CommandPermissions {
  private grants = new Map<string, number>();
  private generation = 0;
  get epoch(): number { return this.generation; }

  grant(args: unknown, epoch: number): boolean {
    if (epoch !== this.generation) return false;
    const key = commandKey(args);
    if (!key) return false;
    this.grants.set(key, (this.grants.get(key) ?? 0) + 1);
    return true;
  }

  consume(args: unknown): boolean {
    const key = commandKey(args);
    const count = key ? this.grants.get(key) ?? 0 : 0;
    if (!key || !count) return false;
    if (count === 1) this.grants.delete(key); else this.grants.set(key, count - 1);
    return true;
  }

  revoke(): void { this.generation++; this.grants.clear(); }
}

export class EditPermissions {
  private grants = new Map<string, () => void>();
  private key(name: string, args: unknown): string {
    const value = (typeof args === 'string' ? JSON.parse(args) : args) as Record<string, unknown>;
    return JSON.stringify([name, Object.keys(value).sort().map((key) => [key, value[key]])]);
  }
  grant(name: string, args: unknown, onStaged: () => void = () => {}): () => void {
    const key = this.key(name, args);
    const grant = () => onStaged();
    this.grants.set(key, grant);
    return () => { if (this.grants.get(key) === grant) this.grants.delete(key); };
  }
  take(name: string, args: unknown): (() => void) | undefined {
    try {
      const key = this.key(name, args);
      const onStaged = this.grants.get(key);
      this.grants.delete(key);
      return onStaged;
    } catch { return undefined; }
  }
  revoke(): void { this.grants.clear(); }
}

function commandKey(args: unknown): string | undefined {
  try {
    const value = (typeof args === 'string' ? JSON.parse(args) : args) as { command?: unknown; timeout_seconds?: unknown };
    if (!value || typeof value.command !== 'string' || !value.command.trim()) return undefined;
    return JSON.stringify([value.command, value.timeout_seconds ?? 120]);
  } catch { return undefined; }
}
