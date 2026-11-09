/**
 * Classic token bucket. `rate` tokens per second refill up to `burst`.
 * A non-positive rate means "unlimited".
 */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    readonly rate: number,
    readonly burst: number = Math.max(1, Math.ceil(rate)),
    now = Date.now(),
  ) {
    this.tokens = burst;
    this.last = now;
  }

  get unlimited(): boolean {
    return !(this.rate > 0);
  }

  private refill(now: number): void {
    if (this.unlimited) return;
    const elapsed = Math.max(0, now - this.last) / 1000;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.rate);
    this.last = now;
  }

  tryTake(n = 1, now = Date.now()): boolean {
    if (this.unlimited) return true;
    this.refill(now);
    if (this.tokens >= n) {
      this.tokens -= n;
      return true;
    }
    return false;
  }

  /** Milliseconds until `n` tokens are available. */
  waitMs(n = 1, now = Date.now()): number {
    if (this.unlimited) return 0;
    this.refill(now);
    if (this.tokens >= n) return 0;
    return Math.ceil(((n - this.tokens) / this.rate) * 1000);
  }

  available(now = Date.now()): number {
    if (this.unlimited) return Number.POSITIVE_INFINITY;
    this.refill(now);
    return this.tokens;
  }
}

/** Keyed token buckets with idle eviction, e.g. one bucket per wallet or IP. */
export class KeyedRateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();
  private lastSweep = Date.now();

  constructor(
    private readonly rate: number,
    private readonly burst: number = Math.max(1, Math.ceil(rate * 2)),
    private readonly maxKeys = 100_000,
  ) {}

  tryTake(key: string, n = 1, now = Date.now()): { ok: boolean; retryAfterMs: number } {
    if (!(this.rate > 0)) return { ok: true, retryAfterMs: 0 };
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maxKeys) this.sweep(now, true);
      bucket = new TokenBucket(this.rate, this.burst, now);
      this.buckets.set(key, bucket);
    }
    if (now - this.lastSweep > 60_000) this.sweep(now, false);
    if (bucket.tryTake(n, now)) return { ok: true, retryAfterMs: 0 };
    return { ok: false, retryAfterMs: bucket.waitMs(n, now) };
  }

  private sweep(now: number, aggressive: boolean): void {
    this.lastSweep = now;
    for (const [key, bucket] of this.buckets) {
      if (aggressive || bucket.available(now) >= this.burst) this.buckets.delete(key);
    }
  }
}
