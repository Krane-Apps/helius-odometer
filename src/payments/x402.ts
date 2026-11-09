import type { Context } from "hono";
import {
  AfterSettleAbortError,
  HTTPFacilitatorClient,
  x402HTTPResourceServer,
  x402ResourceServer,
  type FacilitatorClient,
  type HTTPAdapter,
  type HTTPProcessResult,
  type HTTPRequestContext,
  type RouteConfig,
  type RoutesConfig,
} from "@x402/core/server";
import type { PaymentOption } from "@x402/core/http";
import type { Network, PaymentPayload } from "@x402/core/types";
import { createSIWxResourceServerExtension, declareSIWxExtension } from "@x402/extensions/sign-in-with-x";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import type { Config } from "../config.js";
import type { Ledger } from "../ledger/ledger.js";
import type { Tier } from "../pricing/pricing.js";
import { canonicalJson, sha256Hex } from "../util/json.js";
import type { Logger } from "../util/log.js";
import { atomicToMicros, microsToAtomic, usdToMicros } from "../util/money.js";
import { CachedBlockhashExactSvmScheme, type BlockhashCache } from "./blockhash.js";

/** Extra context the 402 body explains to the agent (why it must pay). */
export interface ChallengeContext {
  reason: "payment_required" | "insufficient_balance" | "daily_cap_exceeded" | "session_invalid";
  wallet?: string;
  price?: number;
  available?: number;
  detail?: string;
}

/** Hono adapter that serves the already-parsed body and carries challenge context. */
export class OdometerAdapter implements HTTPAdapter {
  constructor(
    private readonly c: Context,
    private readonly body: unknown,
    readonly challenge: ChallengeContext,
  ) {}
  getHeader(name: string): string | undefined {
    return this.c.req.header(name);
  }
  getMethod(): string {
    return this.c.req.method;
  }
  getPath(): string {
    return this.c.req.path;
  }
  getUrl(): string {
    return this.c.req.url;
  }
  getAcceptHeader(): string {
    return this.c.req.header("accept") ?? "";
  }
  getUserAgent(): string {
    return this.c.req.header("user-agent") ?? "";
  }
  getQueryParams(): Record<string, string | string[]> {
    return Object.fromEntries(
      Object.entries(this.c.req.queries()).map(([k, v]) => [k, v.length === 1 ? (v[0] as string) : v]),
    );
  }
  getQueryParam(name: string): string | string[] | undefined {
    const v = this.c.req.queries(name);
    if (!v || v.length === 0) return undefined;
    return v.length === 1 ? v[0] : v;
  }
  getBody(): unknown {
    return this.body;
  }
}

export interface PaymentsOptions {
  config: Config;
  ledger: Ledger;
  logger: Logger;
  enabledTiers: ReadonlySet<Tier>;
  /** Override the facilitator (tests, or an in-process facilitator). */
  facilitator?: FacilitatorClient;
  blockhashes?: BlockhashCache;
  /** Paths of paid Helius REST passthrough routes, e.g. "POST /v1/helius/v0/transactions". */
  restRoutes?: Array<{ pattern: string; description: string }>;
}

export const TIER_DESCRIPTIONS: Record<Tier, string> = {
  economy:
    "Economy tier: standard Solana reads served only by free public RPC. Cheapest, may be slower, never escalated to a paid upstream without your choice.",
  standard:
    "Standard tier: public RPC first with automatic escalation to Helius on rate limits, timeouts, lag or errors.",
  fast: "Fast tier: every call goes straight to Helius, including staked sendTransaction.",
};

/** Hash of the signed scheme payload: the replay key for a top-up. */
export function paymentPayloadHash(payload: Pick<PaymentPayload, "payload"> | { payload: unknown }): string {
  return sha256Hex(canonicalJson(payload.payload));
}

const NO_GRANT_STORAGE = { hasPaid: () => false, recordPayment: () => {} };

const BROWSER_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Helius Odometer</title></head>
<body style="font-family:system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem;line-height:1.5">
<h1>Helius Odometer</h1><p>This endpoint is pay-per-call Solana RPC for AI agents over x402.
Send JSON-RPC with an x402-capable client; see <a href="/llms.txt">/llms.txt</a> and <a href="/pricing">/pricing</a>.</p></body></html>`;

/**
 * x402 integration: the resource server, the facilitator client, the paid
 * routes (each answers 402 with prepaid top-up options) and the settlement
 * hooks that credit the ledger exactly once per on-chain payment.
 */
export class Payments {
  readonly resourceServer: x402ResourceServer;
  readonly httpServer: x402HTTPResourceServer;
  private initPromise?: Promise<void>;
  initialized = false;
  lastInitError?: string;

  constructor(private readonly opts: PaymentsOptions) {
    const { config, ledger, logger } = opts;
    const facilitator =
      opts.facilitator ??
      new HTTPFacilitatorClient({
        url: config.facilitatorUrl,
        timeoutMs: 60_000,
        createAuthHeaders: config.facilitatorAuthHeader
          ? async () => {
              const h = { Authorization: config.facilitatorAuthHeader! };
              return { verify: h, settle: h, supported: h, bazaar: h };
            }
          : undefined,
      });

    this.resourceServer = new x402ResourceServer(facilitator)
      .register(config.network as Network, new CachedBlockhashExactSvmScheme(opts.blockhashes))
      .registerExtension(bazaarResourceServerExtension)
      .registerExtension(createSIWxResourceServerExtension({ storage: NO_GRANT_STORAGE, origin: config.publicOrigin }));

    const decimals = config.paymentAssetDecimals;
    this.resourceServer.onBeforeSettle(async (ctx) => {
      const begin = ledger.beginTopup({
        payloadHash: paymentPayloadHash(ctx.paymentPayload),
        network: ctx.requirements.network,
        asset: ctx.requirements.asset,
        amount: atomicToMicros(ctx.requirements.amount, decimals),
      });
      if (begin.status === "duplicate-settled") {
        return { abort: true, reason: "duplicate_payment", message: "This payment was already settled and credited" };
      }
      if (begin.status === "duplicate-in-flight") {
        return { abort: true, reason: "payment_in_flight", message: "This payment is already being settled" };
      }
      return undefined;
    });

    this.resourceServer.onAfterSettle(async (ctx) => {
      const payloadHash = paymentPayloadHash(ctx.paymentPayload);
      const payer = ctx.result.payer;
      const txSignature = ctx.result.transaction;
      if (ctx.requirements.payTo !== config.payTo || ctx.requirements.asset !== config.paymentAsset) {
        ledger.markTopupNeedsReview(payloadHash, "settled requirements do not match gateway configuration");
        throw new AfterSettleAbortError("requirements_mismatch", "Settled requirements do not match this gateway");
      }
      if (!payer || !txSignature) {
        ledger.markTopupNeedsReview(payloadHash, "settlement response missing payer or transaction", {
          txSignature: txSignature || undefined,
        });
        throw new AfterSettleAbortError("missing_payer", "Settlement did not report the paying wallet");
      }
      const amount = atomicToMicros(ctx.result.amount ?? ctx.requirements.amount, decimals);
      try {
        const res = ledger.completeTopup({
          payloadHash,
          wallet: payer,
          txSignature,
          amount,
          network: ctx.requirements.network,
          asset: ctx.requirements.asset,
        });
        if (res.credited) {
          ledger.recordEvent("topup", payer, txSignature);
          logger.info("top-up credited", { wallet: payer, amount, txSignature, balance: res.balance });
        }
      } catch (err) {
        logger.error("top-up settled but not recorded", { wallet: payer, txSignature, amount, error: err });
        try {
          ledger.markTopupNeedsReview(payloadHash, `ledger error: ${err instanceof Error ? err.message : String(err)}`, {
            wallet: payer,
            txSignature,
          });
        } catch {
          // Nothing more we can do; the structured log line above is the recovery record.
        }
        throw new AfterSettleAbortError(
          "ledger_unavailable",
          `Payment settled (${txSignature}) but could not be recorded; contact the operator with this signature`,
        );
      }
    });

    this.resourceServer.onSettleFailure(async (ctx) => {
      ledger.failTopup(paymentPayloadHash(ctx.paymentPayload), ctx.error.message);
      return undefined;
    });

    this.httpServer = new x402HTTPResourceServer(this.resourceServer, this.routes());
  }

  /** One `exact` option per configured top-up denomination, smallest first. */
  topupOptions(): PaymentOption[] {
    const { config } = this.opts;
    return config.topupOptionsUsd.map((usd) => ({
      scheme: "exact",
      network: config.network as Network,
      payTo: config.payTo,
      price: { asset: config.paymentAsset, amount: microsToAtomic(usdToMicros(usd), config.paymentAssetDecimals).toString() },
      maxTimeoutSeconds: config.maxTimeoutSeconds,
      extra: { paymentFlow: "upfront" },
    }));
  }

  private routeConfig(resourcePath: string, description: string, bazaar: Record<string, unknown>): RouteConfig {
    const { config } = this.opts;
    return {
      accepts: this.topupOptions(),
      resource: `${config.publicOrigin}${resourcePath}`,
      description,
      mimeType: "application/json",
      serviceName: "Helius Odometer",
      tags: ["solana", "rpc", "helius", "prepaid"],
      customPaywallHtml: BROWSER_HTML,
      unpaidResponseBody: (ctx) => this.unpaidBody(ctx),
      extensions: {
        ...declareSIWxExtension({
          statement: "Sign in to Helius Odometer to spend your prepaid RPC balance",
          expirationSeconds: 300,
        }),
        ...bazaar,
      },
    };
  }

  routes(): RoutesConfig {
    const routes: Record<string, RouteConfig> = {};
    const rpcBazaar = declareDiscoveryExtension({
      bodyType: "json",
      input: { jsonrpc: "2.0", id: 1, method: "getBalance", params: ["<base58 address>"] },
      inputSchema: {
        type: "object",
        properties: {
          jsonrpc: { type: "string", enum: ["2.0"] },
          id: { type: ["string", "number", "null"] },
          method: { type: "string", description: "Solana JSON-RPC or Helius DAS method" },
          params: { type: ["array", "object"] },
        },
        required: ["jsonrpc", "method"],
      },
      output: { example: { jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: 1_000_000 } } },
    });
    for (const tier of this.opts.enabledTiers) {
      routes[`POST /v1/rpc/${tier}`] = this.routeConfig(
        `/v1/rpc/${tier}`,
        `Prepaid balance top-up for Helius Odometer pay-per-call Solana RPC. ${TIER_DESCRIPTIONS[tier]} Each call is debited from your balance; see /pricing.`,
        rpcBazaar,
      );
    }
    routes["POST /v1/topup"] = this.routeConfig(
      "/v1/topup",
      "Prepaid balance top-up for Helius Odometer. Returns your balance and a session token.",
      declareDiscoveryExtension({ bodyType: "json", input: {}, output: { example: { wallet: "<address>", balanceUsd: "1" } } }),
    );
    for (const r of this.opts.restRoutes ?? []) {
      const [method] = r.pattern.split(" ");
      const bazaar =
        method === "GET"
          ? declareDiscoveryExtension({ input: {}, output: { example: [] } })
          : declareDiscoveryExtension({ bodyType: "json", input: {}, output: { example: [] } });
      routes[r.pattern] = this.routeConfig(r.pattern.split(" ")[1]!.replace(/\*$/, ""), r.description, bazaar);
    }
    return routes;
  }

  private unpaidBody(ctx: HTTPRequestContext): { contentType: string; body: unknown } {
    const { config } = this.opts;
    const challenge = ctx.adapter instanceof OdometerAdapter ? ctx.adapter.challenge : { reason: "payment_required" as const };
    const messages: Record<ChallengeContext["reason"], string> = {
      payment_required:
        "Payment required. Pay one of the x402 `accepts` options (a prepaid USDC top-up); each call is then debited from your balance.",
      insufficient_balance: "Your prepaid balance is too low for this call. Pay one of the x402 `accepts` options to top up.",
      daily_cap_exceeded: "This wallet reached its daily spend cap. Lower usage or raise the cap with POST /v1/account/cap.",
      session_invalid: "Your session token is invalid or expired. Sign in again with SIGN-IN-WITH-X, or top up.",
    };
    return {
      contentType: "application/json",
      body: {
        error: challenge.reason,
        message: messages[challenge.reason],
        detail: challenge.detail,
        wallet: challenge.wallet,
        priceMicros: challenge.price,
        availableMicros: challenge.available,
        topupOptionsUsd: config.topupOptionsUsd,
        auth: {
          session: "After paying or signing in, reuse the X-Odometer-Session token as `Authorization: Bearer <token>`.",
          siwx: "Or sign the `sign-in-with-x` challenge and send it in the SIGN-IN-WITH-X header.",
          challengeUrl: `${config.publicOrigin}/v1/auth/challenge`,
        },
        docs: `${config.publicOrigin}/llms.txt`,
        pricing: `${config.publicOrigin}/pricing`,
      },
    };
  }

  /** Fetches facilitator capabilities; retried by the caller until it succeeds. */
  initialize(): Promise<void> {
    if (this.initialized) return Promise.resolve();
    if (!this.initPromise) {
      this.initPromise = this.httpServer
        .initialize()
        .then(() => {
          this.initialized = true;
          this.lastInitError = undefined;
        })
        .catch((err: unknown) => {
          this.lastInitError = err instanceof Error ? err.message : String(err);
          this.initPromise = undefined;
          throw err;
        });
    }
    return this.initPromise;
  }

  /** Keeps retrying initialization in the background with capped backoff. */
  initializeInBackground(onError: (err: unknown) => void): void {
    let delay = 1000;
    const attempt = () => {
      this.initialize().catch((err) => {
        onError(err);
        const t = setTimeout(attempt, delay);
        t.unref();
        delay = Math.min(delay * 2, 60_000);
      });
    };
    attempt();
  }

  async process(c: Context, body: unknown, challenge: ChallengeContext): Promise<HTTPProcessResult> {
    const adapter = new OdometerAdapter(c, body, challenge);
    const context: HTTPRequestContext = {
      adapter,
      path: c.req.path,
      method: c.req.method,
      paymentHeader: adapter.getHeader("payment-signature") ?? adapter.getHeader("x-payment"),
    };
    return this.httpServer.processHTTPRequest(context);
  }
}
