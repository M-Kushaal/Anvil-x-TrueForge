# Cache

Cache stores string values with expiration times. Use `Cache.set(key, value, ttl)`
and `Cache.get(key)` to read a value while its time to live remains positive.

## Expiration

Expired entries are not returned. A caller may pass a clock value to `get`.
