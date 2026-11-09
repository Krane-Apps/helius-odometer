import type { Logger } from "../util/log.js";
import { Upstream, type UpstreamSnapshot } from "./upstream.js";

export interface PoolOptions {
  maxSlotLag: number;
  healthPollMs: number;
  heliusHealthPollMs: number;
  /** A slot observation older than this is ignored for lag decisions. */
  slotFreshMs?: number;
}

/**
 * Holds every upstream, tracks the best known slot, polls health and picks
 * the next upstream for a request. Only "confirmed" slot observations feed
 * lag decisions so different commitment levels never get compared.
 */
export class UpstreamPool {
  readonly publics: Upstream[];
  readonly helius?: Upstream;
  readonly sender?: Upstream;
  private timers: NodeJS.Timeout[] = [];
  private readonly slotFreshMs: number;

  constructor(
    upstreams: { publics: Upstream[]; helius?: Upstream; sender?: Upstream },
    private readonly opts: PoolOptions,
    private readonly logger: Logger,
  ) {
    this.publics = upstreams.publics;
    this.helius = upstreams.helius;
    this.sender = upstreams.sender;
    this.slotFreshMs = opts.slotFreshMs ?? Math.max(15_000, opts.healthPollMs * 5);
  }

  all(): Upstream[] {
    return [...this.publics, ...(this.helius ? [this.helius] : []), ...(this.sender ? [this.sender] : [])];
  }

  bestSlot(now = Date.now()): number | undefined {
    let best: number | undefined;
    for (const u of this.all()) {
      if (u.kind === "sender" || u.lastSlot === undefined || now - u.lastSlotAt > this.slotFreshMs) continue;
      if (best === undefined || u.lastSlot > best) best = u.lastSlot;
    }
    return best;
  }

  isLagging(u: Upstream, now = Date.now()): boolean {
    if (u.lastSlot === undefined || now - u.lastSlotAt > this.slotFreshMs) return false;
    const best = this.bestSlot(now);
    return best !== undefined && best - u.lastSlot > this.opts.maxSlotLag;
  }

  /** Public upstreams that could serve `method` right now, ignoring rate limits. */
  eligiblePublics(method: string, exclude: ReadonlySet<string>, now = Date.now()): Upstream[] {
    return this.publics.filter(
      (u) => !exclude.has(u.id) && u.serves(method) && u.isAvailable(now) && !this.isLagging(u, now),
    );
  }

  /**
   * Picks a public upstream with a free rate-limit token using "power of two
   * choices" on latency, weighted by configured weight.
   */
  pickPublic(method: string, exclude: ReadonlySet<string>, now = Date.now()): Upstream | undefined {
    const candidates = this.eligiblePublics(method, exclude, now).filter((u) => u.bucket.available(now) >= 1);
    if (candidates.length === 0) return undefined;
    const first = weightedRandom(candidates);
    const rest = candidates.filter((u) => u !== first);
    const second = rest.length ? weightedRandom(rest) : undefined;
    const chosen = second && second.ewmaLatencyMs / second.weight < first.ewmaLatencyMs / first.weight ? second : first;
    return chosen.tryTake(undefined, now) ? chosen : undefined;
  }

  /** Earliest time any eligible public upstream will have a token, for queueing. */
  publicWaitMs(method: string, exclude: ReadonlySet<string>, now = Date.now()): number | undefined {
    const eligible = this.eligiblePublics(method, exclude, now);
    if (eligible.length === 0) return undefined;
    return Math.min(...eligible.map((u) => u.waitMs(undefined, now)));
  }

  start(): void {
    this.stop();
    if (this.publics.length) {
      this.timers.push(setInterval(() => void this.pollPublics(), this.opts.healthPollMs));
      void this.pollPublics();
    }
    if (this.helius && this.opts.heliusHealthPollMs > 0) {
      const helius = this.helius;
      this.timers.push(setInterval(() => void this.probe(helius), this.opts.heliusHealthPollMs));
      void this.probe(helius);
    }
    for (const t of this.timers) t.unref();
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  async pollPublics(): Promise<void> {
    await Promise.all(this.publics.map((u) => this.probe(u)));
  }

  /** One health probe: getSlot at confirmed commitment. Respects the upstream's rate limit. */
  async probe(u: Upstream): Promise<void> {
    if (!u.tryTake()) return;
    const out = await u.call(
      { jsonrpc: "2.0", id: 1, method: "getSlot", params: [{ commitment: "confirmed" }] },
      Math.max(1000, Math.min(5000, this.opts.healthPollMs * 2)),
    );
    const now = Date.now();
    if (out.kind === "ok" && "result" in out.body && typeof out.body.result === "number") {
      u.observeSlot(out.body.result, now);
      u.noteSuccess(out.latencyMs, now);
      return;
    }
    if (out.kind === "rate-limited") {
      u.noteRateLimited(out.retryAfterMs, now);
      return;
    }
    const wasEjected = u.isEjected(now);
    u.noteFailure(now);
    if (!wasEjected && u.isEjected(now)) this.logger.warn("upstream ejected", { upstream: u.id, outcome: out.kind });
  }

  snapshot(now = Date.now()): { bestSlot?: number; upstreams: Array<UpstreamSnapshot & { lagging: boolean }> } {
    const best = this.bestSlot(now);
    return {
      bestSlot: best,
      upstreams: this.all().map((u) => ({ ...u.snapshot(best, now), lagging: this.isLagging(u, now) })),
    };
  }
}

function weightedRandom(items: Upstream[]): Upstream {
  const total = items.reduce((s, u) => s + u.weight, 0);
  let r = Math.random() * total;
  for (const u of items) {
    r -= u.weight;
    if (r <= 0) return u;
  }
  return items[items.length - 1]!;
}
