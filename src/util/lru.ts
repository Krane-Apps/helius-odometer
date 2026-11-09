/** Small LRU cache bounded by entry count and an optional byte budget. */
export class LruCache<K, V> {
  private readonly map = new Map<K, { value: V; size: number; expiresAt: number }>();
  private bytes = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly maxBytes = Number.POSITIVE_INFINITY,
  ) {}

  get(key: K, now = Date.now()): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V, opts: { size?: number; ttlMs?: number } = {}, now = Date.now()): void {
    const size = opts.size ?? 0;
    if (size > this.maxBytes) return;
    this.delete(key);
    this.map.set(key, { value, size, expiresAt: opts.ttlMs ? now + opts.ttlMs : Number.POSITIVE_INFINITY });
    this.bytes += size;
    while (this.map.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.delete(oldest.value);
    }
  }

  delete(key: K): void {
    const entry = this.map.get(key);
    if (!entry) return;
    this.bytes -= entry.size;
    this.map.delete(key);
  }

  get size(): number {
    return this.map.size;
  }

  get byteSize(): number {
    return this.bytes;
  }
}
