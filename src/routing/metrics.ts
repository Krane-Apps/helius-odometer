/** Rolling latency samples per (tier, method, upstream class) for the status page. */
export class LatencyMetrics {
  private readonly series = new Map<string, Series>();

  constructor(private readonly window = 1024) {}

  record(tier: string, method: string, upstreamClass: string, latencyMs: number, ok: boolean): void {
    const key = `${tier}|${method}|${upstreamClass}`;
    let s = this.series.get(key);
    if (!s) {
      s = new Series(this.window);
      this.series.set(key, s);
    }
    s.add(latencyMs, ok);
  }

  snapshot(): Array<{
    tier: string;
    method: string;
    upstreamClass: string;
    count: number;
    errors: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
  }> {
    const out = [];
    for (const [key, s] of this.series) {
      const [tier, method, upstreamClass] = key.split("|") as [string, string, string];
      out.push({ tier, method, upstreamClass, count: s.count, errors: s.errors, ...s.percentiles() });
    }
    return out.sort((a, b) => b.count - a.count);
  }
}

class Series {
  private readonly samples: number[] = [];
  private next = 0;
  count = 0;
  errors = 0;

  constructor(private readonly size: number) {}

  add(latencyMs: number, ok: boolean): void {
    this.count += 1;
    if (!ok) this.errors += 1;
    if (this.samples.length < this.size) this.samples.push(latencyMs);
    else {
      this.samples[this.next] = latencyMs;
      this.next = (this.next + 1) % this.size;
    }
  }

  percentiles(): { p50Ms: number; p95Ms: number; p99Ms: number } {
    if (this.samples.length === 0) return { p50Ms: 0, p95Ms: 0, p99Ms: 0 };
    const sorted = [...this.samples].sort((a, b) => a - b);
    const at = (q: number) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!);
    return { p50Ms: at(0.5), p95Ms: at(0.95), p99Ms: at(0.99) };
  }
}
