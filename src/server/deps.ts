import type { Context } from "hono";
import type { Alerter } from "./alerts.js";
import type { Config } from "../config.js";
import type { Ledger } from "../ledger/ledger.js";
import type { BlockhashCache } from "../payments/blockhash.js";
import type { Paywall } from "../payments/paywall.js";
import type { SessionManager } from "../payments/session.js";
import type { SiwxAuth } from "../payments/siwx.js";
import type { Payments } from "../payments/x402.js";
import type { Pricing, PricingOptions, Tier } from "../pricing/pricing.js";
import type { LatencyMetrics } from "../routing/metrics.js";
import type { UpstreamPool } from "../routing/pool.js";
import type { Rebroadcaster } from "../routing/rebroadcast.js";
import type { Router } from "../routing/router.js";
import type { Logger } from "../util/log.js";
import type { LruCache } from "../util/lru.js";
import type { KeyedRateLimiter } from "../util/token-bucket.js";

/** In-memory operating counters for the admin view (reset on restart). */
export interface Counters {
  calls: number;
  billableCalls: number;
  revenueMicros: number;
  heliusCalls: number;
  heliusCreditsEstimate: number;
  publicCalls: number;
  cacheHits: number;
  escalations: number;
  challenges: number;
  topups: number;
}

export interface AppDeps {
  config: Config;
  logger: Logger;
  ledger: Ledger;
  pricing: Pricing;
  pricingOptions: PricingOptions;
  enabledTiers: ReadonlySet<Tier>;
  pool: UpstreamPool;
  router: Router;
  metrics: LatencyMetrics;
  payments: Payments;
  paywall: Paywall;
  sessions: SessionManager;
  siwx: SiwxAuth;
  walletLimiter: KeyedRateLimiter;
  ipLimiter: KeyedRateLimiter;
  bootstrapLimiter: KeyedRateLimiter;
  blockhashes: BlockhashCache;
  rebroadcaster: Rebroadcaster;
  bootstrapCache: LruCache<string, unknown>;
  counters: Counters;
  alerter: Alerter;
  /** Identity of this process in the ledger's single-writer lock. */
  writerOwner: string;
  /** Run when a wallet revokes its sessions (e.g. to terminate its remote MCP sessions). */
  walletRevocationHooks: Array<(wallet: string) => Promise<void> | void>;
  startedAt: number;
  clientIp: (c: Context) => string;
}
