export class Cache {
  private entries = new Map<string, { value: string; expires: number }>();

  get(key: string, now = Date.now()): string | undefined {
    const entry = this.entries.get(key);
    return entry && entry.expires > now ? entry.value : undefined;
  }

  set(key: string, value: string, ttl: number): void {
    this.entries.set(key, { value, expires: Date.now() + ttl });
  }
}
