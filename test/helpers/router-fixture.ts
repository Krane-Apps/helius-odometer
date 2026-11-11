import { UpstreamPool } from "../../src/routing/pool.js";
import { Upstream } from "../../src/routing/upstream.js";
import { Router, type RouterOptions } from "../../src/routing/router.js";
import { LatencyMetrics } from "../../src/routing/metrics.js";
import type { Rebroadcaster } from "../../src/routing/rebroadcast.js";
import { SlotHighWaterMarks, TxSessions } from "../../src/routing/consistency.js";
import { LruCache } from "../../src/util/lru.js";
import { silentLogger } from "../../src/util/log.js";
import { TokenBucket } from "../../src/util/token-bucket.js";

export interface FixtureOptions {
  publics: Array<{ id: string; url: string; rps?: number; denyMethods?: string[] }>;
  helius?: { url: string; rps?: number; sendRps?: number; heavyRps?: number };
  sender?: { url: string };
  router?: Partial<RouterOptions>;
  rebroadcaster?: Rebroadcaster;
  maxSlotLag?: number;
}

export function buildRouter(opts: FixtureOptions) {
  const publics = opts.publics.map(
    (p) => new Upstream({ id: p.id, url: p.url, rps: p.rps ?? 0, denyMethods: p.denyMethods ?? [], weight: 1, kind: "public" }),
  );
  const helius = opts.helius
    ? new Upstream({ id: "helius", url: opts.helius.url, rps: opts.helius.rps ?? 0, denyMethods: [], weight: 1, kind: "helius" })
    : undefined;
  if (helius && opts.helius?.sendRps) helius.groupBuckets.set("send", new TokenBucket(opts.helius.sendRps, opts.helius.sendRps));
  if (helius && opts.helius?.heavyRps) helius.groupBuckets.set("heavy", new TokenBucket(opts.helius.heavyRps, opts.helius.heavyRps));
  const sender = opts.sender
    ? new Upstream({ id: "sender", url: opts.sender.url, rps: 0, denyMethods: [], weight: 1, kind: "sender" })
    : undefined;
  const pool = new UpstreamPool(
    { publics, helius, sender },
    { maxSlotLag: opts.maxSlotLag ?? 50, healthPollMs: 1000, heliusHealthPollMs: 0 },
    silentLogger,
  );
  const metrics = new LatencyMetrics();
  const hwm = new SlotHighWaterMarks(4);
  const txSessions = new TxSessions();
  const cache = new LruCache<string, unknown>(1000, 1_000_000);
  const router = new Router({
    pool,
    metrics,
    hwm,
    txSessions,
    cache,
    rebroadcaster: opts.rebroadcaster,
    logger: silentLogger,
    options: {
      defaultCommitment: { economy: "confirmed", standard: "confirmed", fast: undefined },
      publicAttemptTimeoutMs: 500,
      maxPublicAttempts: 2,
      economyQueueMs: 200,
      heliusQueueMs: 100,
      cacheMaxEntryBytes: 100_000,
      sendPreflightCommitment: "confirmed",
      ...opts.router,
    },
  });
  return { router, pool, publics, helius, sender, metrics, hwm, txSessions, cache };
}
