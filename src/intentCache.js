export class IntentCache {
  constructor({ maxEntries = 500, defaultTtlMs = 24 * 60 * 60 * 1000 } = {}) {
    this.maxEntries = maxEntries;
    this.defaultTtlMs = defaultTtlMs;
    this.map = new Map();
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return null;

    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return null;
    }

    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key, value, { ttlMs } = {}) {
    const effectiveTtlMs = typeof ttlMs === 'number' ? ttlMs : this.defaultTtlMs;
    const expiresAt = effectiveTtlMs === null ? null : Date.now() + effectiveTtlMs;

    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expiresAt });

    while (this.map.size > this.maxEntries) {
      const oldestKey = this.map.keys().next().value;
      this.map.delete(oldestKey);
    }
  }

  delete(key) {
    this.map.delete(key);
  }
}

