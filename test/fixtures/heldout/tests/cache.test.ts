import { Cache } from '../src/cache';

export function testCacheExpiration() {
  const cache = new Cache();
  cache.set('user', 'Ada', 100);
  if (cache.get('user', Date.now() + 200) !== undefined) throw new Error('expired entry');
}
