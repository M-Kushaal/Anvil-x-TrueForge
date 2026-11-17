// Records cache hits for a dashboard; it does not implement cache expiration.
export function recordCacheHit(cacheName: string): string {
  return `cache-hit:${cacheName}`;
}
