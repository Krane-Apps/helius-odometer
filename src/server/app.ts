import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { FacilitatorClient } from "@x402/core/server";
import { enabledTiers as computeEnabledTiers, type Config } from "../config.js";
import { Ledger } from "../ledger/ledger.js";
import { BlockhashCache } from "../payments/blockhash.js";
import { Paywall } from "../payments/paywall.js";
import { SessionManager } from "../payments/session.js";
import { SiwxAuth } from "../payments/siwx.js";
import { Payments, siwxStatement } from "../payments/x402.js";
import { Pricing, type PricingOptions } from "../pricing/pricing.js";
import { SlotHighWaterMarks, TxSessions } from "../routing/consistency.js";
import { LatencyMetrics } from "../routing/metrics.js";
import { UpstreamPool } from "../routing/pool.js";
import { Rebroadcaster } from "../routing/rebroadcast.js";
import { Router } from "../routing/router.js";
import { Upstream } from "../routing/upstream.js";
import { registerAdminRoutes } from "../api/admin.js";
import { registerRemoteMcp } from "../mcp/remote.js";
import { registerPublicRoutes } from "../api/public.js";
import { registerBootstrapRoutes } from "../rpc/bootstrap.js";
import { registerRpcRoutes } from "../rpc/handler.js";
import { REST_ROUTES, registerHeliusRestRoutes, restEnabled } from "../rpc/helius-rest.js";
import { hostname } from "node:os";
import { createLogger, type Logger } from "../util/log.js";
import { randomHex } from "../util/ids.js";
import { Alerter } from "./alerts.js";
import { LruCache } from "../util/lru.js";
import { usdToMicros } from "../util/money.js";
import { KeyedRateLimiter, TokenBucket } from "../util/token-bucket.js";
import type { AppDeps, Counters } from "./deps.js";
import { jsonResponse, ODOMETER_HEADERS } from "./http.js";

export interface CreateAppOptions {
  config: Config;
  logger?: Logger;
  /** Replace the HTTP facilitator client (tests, in-process facilitator). */
  facilitator?: FacilitatorClient;
  fetchImpl?: typeof fetch;
  /** Called if another process takes over the ledger's writer lock; the entrypoint exits. */
  onWriterLockLost?: () => void;
}

export interface OdometerApp {
  app: Hono;
  deps: AppDeps;
  /** Starts health polling, facilitator sync and maintenance jobs. */
  start(): void;
  stop(): Promise<void>;
}

export function createApp(opts: CreateAppOptions): OdometerApp {
  const { config } = opts;
  const logger = opts.logger ?? createLogger(config.logLevel, { service: "helius-odometer" });
  const fetchImpl = opts.fetchImpl ?? fetch;
  const ledger = new Ledger({
    path: config.databasePath,
    defaultDailyCap: config.walletDailyCapUsd === null ? null : usdToMicros(config.walletDailyCapUsd),
  });

  const publics = config.publicUpstreams.map((u) => new Upstream({ ...u, kind: "public" }, fetchImpl));
  const helius = config.helius ? new Upstream({ ...config.helius, kind: "helius" }, fetchImpl) : undefined;
  if (helius) {
    helius.groupBuckets.set("send", new TokenBucket(config.heliusSendRps, Math.max(1, config.heliusSendRps)));
    helius.groupBuckets.set("heavy", new TokenBucket(config.heliusHeavyRps, Math.max(1, config.heliusHeavyRps)));
  }
  const sender =
    config.heliusSenderUrl && helius
      ? new Upstream({ id: "helius-sender", url: config.heliusSenderUrl, rps: config.heliusSendRps, denyMethods: [], weight: 1, kind: "sender" }, fetchImpl)
      : undefined;
  const pool = new UpstreamPool(
    { publics, helius, sender },
    { maxSlotLag: config.maxSlotLag, healthPollMs: config.healthPollMs, heliusHealthPollMs: config.heliusHealthPollMs },
    logger,
  );

  const enabledTiers = computeEnabledTiers(config);
  const pricing = new Pricing(config.pricing);
  const pricingOptions: PricingOptions = {
    enabledTiers,
    sendTransactionEnabled: config.sendTransactionEnabled,
    heliusAvailable: !!helius,
  };
  const metrics = new LatencyMetrics();
  const rebroadcaster = new Rebroadcaster(logger, { intervalMs: 2000, maxSeconds: config.rebroadcastMaxSeconds, maxJobs: 500 });
  const router = new Router({
    pool,
    metrics,
    hwm: new SlotHighWaterMarks(config.minContextSlotMargin),
    txSessions: new TxSessions(),
    cache: new LruCache<string, unknown>(5000, 64 * 1024 * 1024),
    rebroadcaster,
    logger,
    options: {
      defaultCommitment: config.defaultCommitment,
      publicAttemptTimeoutMs: config.publicAttemptTimeoutMs,
      maxPublicAttempts: config.maxPublicAttempts,
      economyQueueMs: 1500,
      heliusQueueMs: 500,
      cacheMaxEntryBytes: 4 * 1024 * 1024,
      sendPreflightCommitment: config.sendPreflightCommitment,
    },
  });

  const blockhashes = new BlockhashCache(async () => {
    const upstream = pool.pickPublic("getLatestBlockhash", new Set()) ?? (helius?.tryTake() ? helius : undefined);
    if (!upstream) return undefined;
    const out = await upstream.call({ jsonrpc: "2.0", id: 1, method: "getLatestBlockhash", params: [{ commitment: "confirmed" }] }, 3000);
    if (out.kind !== "ok" || !("result" in out.body)) return undefined;
    const v = (out.body.result as { value?: { blockhash: string; lastValidBlockHeight: number } }).value;
    return v ? { blockhash: v.blockhash, lastValidBlockHeight: v.lastValidBlockHeight } : undefined;
  });

  const alerter = new Alerter({
    webhookUrl: config.alertWebhookUrl,
    authHeader: config.alertWebhookAuthHeader,
    serviceName: config.serviceName,
    dedupeMs: config.alertDedupeMinutes * 60_000,
    logger,
    fetchImpl,
  });
  const payments = new Payments({
    config,
    ledger,
    logger,
    enabledTiers,
    facilitator: opts.facilitator,
    blockhashes,
    onAmbiguousSettlement: (info) =>
      void alerter.alert(`settlement:${info.payloadHash}`, "critical", "Top-up settlement outcome unknown; frozen for operator review", info),
    onSettledButUnrecorded: (info) =>
      void alerter.alert(`unrecorded:${info.txSignature}`, "critical", "Top-up settled on-chain but the ledger could not record it", info),
    restRoutes: restEnabled({ config }) ? REST_ROUTES.map((r) => ({ pattern: r.pattern, description: r.description })) : [],
  });
  const sessions = new SessionManager(config.sessionSecret, config.sessionTtlSeconds, (w) => ledger.getAccount(w)?.sessionEpoch ?? 0);
  const siwx = new SiwxAuth({
    origin: config.publicOrigin,
    network: config.network,
    statement: siwxStatement(config.serviceName),
    expirationSeconds: 300,
    useNonce: (nonce, expiresAt) => ledger.useNonce(nonce, expiresAt),
  });
  const clientIp = (c: Context): string => {
    if (config.trustProxy) {
      const fwd = c.req.header("x-forwarded-for");
      if (fwd) return fwd.split(",")[0]!.trim();
    }
    try {
      return getConnInfo(c).remote.address ?? "unknown";
    } catch {
      return "unknown";
    }
  };
  const ipLimiter = new KeyedRateLimiter(config.ipRps, Math.max(1, config.ipRps * 2));
  const paywall = new Paywall({ payments, ledger, sessions, siwx, logger, clientIp, challengeLimiter: ipLimiter });
  const counters: Counters = {
    calls: 0,
    billableCalls: 0,
    revenueMicros: 0,
    heliusCalls: 0,
    heliusCreditsEstimate: 0,
    publicCalls: 0,
    cacheHits: 0,
    escalations: 0,
    challenges: 0,
    topups: 0,
  };

  const deps: AppDeps = {
    config,
    logger,
    ledger,
    pricing,
    pricingOptions,
    enabledTiers,
    pool,
    router,
    metrics,
    payments,
    paywall,
    sessions,
    siwx,
    walletLimiter: new KeyedRateLimiter(config.walletRps, Math.max(1, config.walletRps * 2)),
    ipLimiter,
    bootstrapLimiter: new KeyedRateLimiter(1, 20),
    blockhashes,
    rebroadcaster,
    bootstrapCache: new LruCache<string, unknown>(1000),
    counters,
    alerter,
    writerOwner: `${hostname()}:${process.pid}:${randomHex(4)}`,
    walletRevocationHooks: [],
    startedAt: Date.now(),
    clientIp,
  };

  const app = new Hono();
  app.use(
    "*",
    cors({
      origin: "*",
      allowHeaders: [
        "content-type",
        "authorization",
        "payment-signature",
        "x-payment",
        "sign-in-with-x",
        "idempotency-key",
        "x-odometer-max-price",
        "x-odometer-send-via",
        "x-odometer-rebroadcast",
        "mcp-session-id",
        "mcp-protocol-version",
      ],
      exposeHeaders: ["payment-required", "payment-response", "x-payment-response", "mcp-session-id", ...ODOMETER_HEADERS],
    }),
  );
  app.use(
    "/mcp",
    bodyLimit({
      maxSize: config.maxBodyBytes,
      onError: (c) => jsonResponse(c, 413, { error: "body_too_large", maxBytes: config.maxBodyBytes }),
    }),
  );
  app.use(
    "/v1/*",
    bodyLimit({
      maxSize: config.maxBodyBytes,
      onError: (c) => jsonResponse(c, 413, { error: "body_too_large", maxBytes: config.maxBodyBytes }),
    }),
  );
  registerPublicRoutes(app, deps);
  registerRpcRoutes(app, deps);
  registerBootstrapRoutes(app, deps);
  registerHeliusRestRoutes(app, deps);
  registerAdminRoutes(app, deps);
  const remoteMcp = config.remoteMcpEnabled ? registerRemoteMcp(app, deps) : undefined;
  app.notFound((c) => jsonResponse(c, 404, { error: "not_found", docs: "/llms.txt" }));
  app.onError((err, c) => {
    logger.error("unhandled error", { path: c.req.path, error: err });
    return jsonResponse(c, 500, { error: "internal_error" });
  });

  const timers: NodeJS.Timeout[] = [];
  return {
    app,
    deps,
    start() {
      // One writer per ledger: refuse to start next to another live process.
      ledger.acquireWriterLock(deps.writerOwner);
      // Anything reserved by a previous process can never finalize: release it and
      // mark its idempotency keys aborted so those requests may be retried.
      const recovered = ledger.recoverAfterRestart();
      if (recovered.releasedReservations || recovered.abortedReceipts) {
        logger.warn("recovered requests interrupted by a previous process", recovered);
      }
      pool.start();
      payments.initializeInBackground((err) =>
        logger.warn("facilitator sync failed; retrying", { error: err instanceof Error ? err.message : String(err) }),
      );
      void blockhashes.refresh();
      timers.push(
        setInterval(() => {
          if (ledger.heartbeatWriterLock(deps.writerOwner)) return;
          void alerter.alert("writer-lock", "critical", "Another process took over the ledger writer lock; this process stops writing", {
            owner: deps.writerOwner,
          });
          opts.onWriterLockLost?.();
        }, 10_000),
        setInterval(() => {
          const report = ledger.reconcile();
          if (report.ok) return;
          const summary = {
            arithmeticOk: report.arithmeticOk,
            balanceMismatches: report.balanceMismatches.length,
            reservedMismatches: report.reservedMismatches.length,
            unresolvedTopups: report.unresolvedTopups,
          };
          if (!report.arithmeticOk) void alerter.alert("reconcile-mismatch", "critical", "Ledger arithmetic mismatch: stop traffic and investigate", summary);
          else void alerter.alert("reconcile-unresolved", "warning", report.warnings.join("; "), summary);
        }, 60_000),
        setInterval(() => {
          ledger.pruneNonces();
          ledger.pruneIdempotency(config.idempotencyRetentionHours * 3_600_000);
          ledger.pruneReservations(config.reservationRetentionDays * 86_400_000);
          ledger.pruneEvents();
        }, 3_600_000),
      );
      for (const t of timers) t.unref();
    },
    async stop() {
      for (const t of timers) clearInterval(t);
      pool.stop();
      rebroadcaster.stop();
      await remoteMcp?.close();
      try {
        ledger.releaseWriterLock(deps.writerOwner);
      } finally {
        ledger.close();
      }
    },
  };
}
