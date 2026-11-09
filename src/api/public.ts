import type { Context, Hono } from "hono";
import { sessionHeaders } from "../payments/paywall.js";
import { METHODS } from "../pricing/methods.js";
import { TIERS, type Tier } from "../pricing/pricing.js";
import { TIER_DESCRIPTIONS } from "../payments/x402.js";
import { LedgerError } from "../ledger/ledger.js";
import { REST_ROUTES, restEnabled } from "../rpc/helius-rest.js";
import type { AppDeps } from "../server/deps.js";
import { jsonResponse } from "../server/http.js";
import { microsToUsd, usdToMicros } from "../util/money.js";
import { resolveWallet } from "./auth.js";

const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function registerPublicRoutes(app: Hono, deps: AppDeps): void {
  const { config } = deps;

  app.get("/", (c) =>
    c.json({
      name: "Helius Odometer",
      description: "Pay-per-call Solana RPC for AI agents over x402. Wallet in, answers out: no signup, no email, no API key.",
      disclaimer: "Independent project; not affiliated with or endorsed by Helius.",
      network: config.network,
      paymentAsset: config.paymentAsset,
      topupOptionsUsd: config.topupOptionsUsd,
      tiers: [...deps.enabledTiers].map((tier) => ({
        tier,
        endpoint: `${config.publicOrigin}/v1/rpc/${tier}`,
        description: TIER_DESCRIPTIONS[tier],
      })),
      endpoints: {
        pricing: "/pricing",
        status: "/status",
        docs: "/llms.txt",
        discovery: "/.well-known/x402",
        authChallenge: "/v1/auth/challenge",
        session: "/v1/auth/session",
        balance: "/v1/balance",
        topup: "/v1/topup",
        refunds: "/v1/refunds",
        bootstrap: config.bootstrapEnabled ? "/v1/bootstrap" : undefined,
      },
    }),
  );

  app.get("/health", (c) => {
    const snap = deps.pool.snapshot();
    return c.json({
      ok: true,
      uptimeSeconds: Math.round((Date.now() - deps.startedAt) / 1000),
      paymentsReady: deps.payments.initialized,
      paymentsError: deps.payments.initialized ? undefined : deps.payments.lastInitError,
      bestSlot: snap.bestSlot,
      upstreams: snap.upstreams.map((u) => ({ id: u.id, kind: u.kind, available: u.available && !u.lagging })),
    });
  });

  app.get("/pricing", (c) => c.json(pricingDocument(deps)));

  app.get("/status", (c) =>
    c.json({
      generatedAt: new Date().toISOString(),
      note: "Latencies are measured by this gateway over its recent traffic window; they are not a service-level promise.",
      tiers: [...deps.enabledTiers],
      latency: deps.metrics.snapshot(),
      upstreams: deps.pool.snapshot(),
      rebroadcastsActive: deps.rebroadcaster.active,
    }),
  );

  app.get("/llms.txt", (c) => c.text(llmsTxt(deps), 200, { "content-type": "text/plain; charset=utf-8" }));

  app.get("/.well-known/x402", (c) =>
    c.json({
      x402Version: 2,
      service: "Helius Odometer",
      network: config.network,
      payTo: config.payTo,
      asset: config.paymentAsset,
      model: "prepaid-balance",
      topupOptionsUsd: config.topupOptionsUsd,
      resources: [
        ...[...deps.enabledTiers].map((tier) => ({
          method: "POST",
          url: `${config.publicOrigin}/v1/rpc/${tier}`,
          description: TIER_DESCRIPTIONS[tier],
        })),
        { method: "POST", url: `${config.publicOrigin}/v1/topup`, description: "Top up a prepaid balance" },
        ...(restEnabled(deps)
          ? REST_ROUTES.map((r) => ({
              method: r.pattern.split(" ")[0],
              url: `${config.publicOrigin}${r.pattern.split(" ")[1]!.replace("/*", "/{address}/transactions")}`,
              description: r.description,
            }))
          : []),
      ],
    }),
  );

  app.get("/v1/auth/challenge", (c) => c.json(deps.siwx.challenge("/v1/auth/session")));

  app.post("/v1/auth/session", async (c) => {
    const header = c.req.header("sign-in-with-x");
    if (!header) return jsonResponse(c, 400, { error: "missing_siwx", message: "Send a signed SIGN-IN-WITH-X header" });
    const v = await deps.siwx.verifyHeader(header);
    if (!v.ok) return jsonResponse(c, 401, { error: v.reason, message: v.message });
    deps.ledger.recordEvent("siwx", v.wallet);
    const session = deps.sessions.issue(v.wallet);
    const account = deps.ledger.getAccount(v.wallet);
    return jsonResponse(
      c,
      200,
      {
        wallet: v.wallet,
        sessionToken: session.token,
        expiresAt: new Date(session.expiresAt).toISOString(),
        availableMicros: account?.available ?? 0,
        availableUsd: microsToUsd(account?.available ?? 0),
      },
      sessionHeaders(session),
    );
  });

  app.get("/v1/balance", async (c) => {
    const auth = await resolveWallet(c, deps);
    if (!auth.ok) return jsonResponse(c, auth.status, auth.body);
    return jsonResponse(c, 200, accountView(deps, auth.wallet), auth.session ? sessionHeaders(auth.session) : {});
  });

  app.post("/v1/topup", async (c) => {
    const hasPayment = !!(c.req.header("payment-signature") ?? c.req.header("x-payment"));
    if (!hasPayment) {
      if (!deps.payments.initialized) {
        try {
          await deps.payments.initialize();
        } catch {
          return jsonResponse(c, 503, { error: "payments_unavailable" }, { "retry-after": "10" });
        }
      }
      const result = await deps.payments.process(c, {}, { reason: "payment_required" });
      if (result.type === "payment-error") {
        return jsonResponse(c, result.response.status, result.response.body ?? {}, result.response.headers);
      }
      return jsonResponse(c, 500, { error: "payment_configuration_error" });
    }
    const auth = await deps.paywall.authorize(c, 0, {});
    if (auth.kind === "respond") return jsonResponse(c, auth.status, auth.body, auth.headers);
    deps.counters.topups += 1;
    const headers = { ...(auth.paymentHeaders ?? {}), ...(auth.session ? sessionHeaders(auth.session) : {}) };
    return jsonResponse(
      c,
      200,
      { ...accountView(deps, auth.wallet), sessionToken: auth.session?.token, topUp: auth.toppedUp },
      headers,
    );
  });

  app.post("/v1/refunds", async (c) => {
    const auth = await resolveWallet(c, deps);
    if (!auth.ok) return jsonResponse(c, auth.status, auth.body);
    const body = (await c.req.json().catch(() => ({}))) as { amountUsd?: number | string; destination?: string };
    const destination = body.destination ?? auth.wallet;
    if (!ADDRESS_RE.test(destination)) return jsonResponse(c, 400, { error: "invalid_destination" });
    let amount: number | undefined;
    if (body.amountUsd !== undefined) {
      try {
        amount = usdToMicros(body.amountUsd);
      } catch {
        return jsonResponse(c, 400, { error: "invalid_amount" });
      }
    }
    try {
      const refund = deps.ledger.requestRefund(auth.wallet, amount, destination);
      deps.logger.info("refund requested", { wallet: auth.wallet, refund: refund.id, amount: refund.amount });
      return jsonResponse(c, 201, {
        refund: { ...refund, amountUsd: microsToUsd(refund.amount) },
        message: "Refund requested. The operator pays refunds to the destination wallet in USDC.",
      });
    } catch (err) {
      if (err instanceof LedgerError) return jsonResponse(c, 400, { error: err.code, message: err.message });
      throw err;
    }
  });

  app.get("/v1/refunds", async (c) => {
    const auth = await resolveWallet(c, deps);
    if (!auth.ok) return jsonResponse(c, auth.status, auth.body);
    return c.json({ refunds: deps.ledger.listRefunds({ wallet: auth.wallet }) });
  });

  app.post("/v1/account/cap", async (c) => {
    const auth = await resolveWallet(c, deps);
    if (!auth.ok) return jsonResponse(c, auth.status, auth.body);
    const body = (await c.req.json().catch(() => ({}))) as { dailyCapUsd?: number | null };
    let cap: number | null = null;
    if (body.dailyCapUsd !== null && body.dailyCapUsd !== undefined) {
      try {
        cap = usdToMicros(body.dailyCapUsd);
      } catch {
        return jsonResponse(c, 400, { error: "invalid_cap" });
      }
    }
    deps.ledger.setDailyCap(auth.wallet, cap);
    return c.json(accountView(deps, auth.wallet));
  });

  app.post("/v1/session/revoke", async (c) => {
    const auth = await resolveWallet(c, deps);
    if (!auth.ok) return jsonResponse(c, auth.status, auth.body);
    const epoch = deps.ledger.bumpSessionEpoch(auth.wallet);
    return c.json({ wallet: auth.wallet, revoked: true, sessionEpoch: epoch });
  });
}

export function accountView(deps: AppDeps, wallet: string): Record<string, unknown> {
  const account = deps.ledger.getAccount(wallet);
  const cap = deps.ledger.effectiveDailyCap(account);
  const spentToday = deps.ledger.spentToday(wallet);
  return {
    wallet,
    balanceMicros: account?.balance ?? 0,
    availableMicros: account?.available ?? 0,
    reservedMicros: account?.reserved ?? 0,
    availableUsd: microsToUsd(account?.available ?? 0),
    dailyCapUsd: cap > 0 ? microsToUsd(cap) : null,
    spentTodayUsd: microsToUsd(spentToday),
    totalToppedUpUsd: microsToUsd(account?.totalToppedUp ?? 0),
    totalSpentUsd: microsToUsd(account?.totalSpent ?? 0),
    totalRefundedUsd: microsToUsd(account?.totalRefunded ?? 0),
  };
}

export function pricingDocument(deps: AppDeps): Record<string, unknown> {
  const { pricing, pricingOptions, config } = deps;
  const methods = [...METHODS.values()]
    .filter((m) => m.cls !== "D")
    .map((m) => {
      const byTier: Partial<Record<Tier, string | null>> = {};
      for (const tier of TIERS) {
        const q = pricing.priceMethod(tier, m.name, { ...pricingOptions, enabledTiers: new Set(TIERS) });
        byTier[tier] = q.reject ? null : microsToUsd(q.price);
      }
      return {
        method: m.name,
        class: m.cls,
        heliusCredits: m.credits,
        heliusCreditsVerified: m.creditsVerified,
        priceUsd: byTier,
        note: m.note,
      };
    });
  return {
    units: "USD; balances are kept in micros (1e-6 USD = one atomic unit of USDC)",
    note: "Starting prices; the operator may change them. Classes B and C are billed as Helius-backed on every tier.",
    enabledTiers: [...deps.enabledTiers],
    tiers: Object.fromEntries(TIERS.map((t) => [t, { classAUsd: String(config.pricing.classA[t]), description: TIER_DESCRIPTIONS[t] }])),
    heliusBackedByCreditsUsd: config.pricing.heliusBackedByCredits,
    sendTransactionUsd: config.pricing.sendTransaction,
    sendTransactionEnabled: config.sendTransactionEnabled,
    rest: restEnabled(deps) ? config.pricing.rest : {},
    topupOptionsUsd: config.topupOptionsUsd,
    billing: {
      charged: "Successful results and errors caused by the request itself (for example invalid params)",
      notCharged: "Gateway or upstream failures: timeouts, rate limits, unhealthy nodes, exhausted pools",
    },
    methods,
  };
}

function llmsTxt(deps: AppDeps): string {
  const { config } = deps;
  const tiers = [...deps.enabledTiers].map((t) => `- ${t}: POST ${config.publicOrigin}/v1/rpc/${t}  ${TIER_DESCRIPTIONS[t]}`).join("\n");
  return `# Helius Odometer

> Pay-per-call Solana RPC for AI agents over x402. Wallet in, answers out: no signup, no email, no API key.
> Independent project; not affiliated with or endorsed by Helius.

## Choosing a tier
Before your first call, ask your user how important speed is for this task.
${tiers}

## How payment works
1. POST a Solana JSON-RPC request to a tier endpoint.
2. With no balance you get HTTP 402 with a PAYMENT-REQUIRED header listing prepaid USDC top-ups on ${config.network}
   (${config.topupOptionsUsd.map((u) => `$${u}`).join(", ")}). Pay one with any x402 client; the call is then served.
3. The response carries X-Odometer-Session. Send it as "Authorization: Bearer <token>" on later calls:
   each call is debited from your balance, with no new payment and no extra round trip.
4. Alternatively sign the sign-in-with-x challenge (GET /v1/auth/challenge) and send SIGN-IN-WITH-X.

Every response reports X-Odometer-Charged and X-Odometer-Balance (micros: millionths of a USD).
Set X-Odometer-Max-Price (USD) to refuse anything pricier than you expect.
Failures caused by the gateway or upstreams are never charged.

## Endpoints
- GET /pricing   per-method prices for every tier
- GET /status    measured latency and upstream health
- GET /v1/balance, POST /v1/refunds, POST /v1/account/cap (authenticated)
- POST /v1/topup  top up without making a call
${config.bootstrapEnabled ? "- POST /v1/bootstrap  free getLatestBlockhash and payment-mint lookup for building the payment\n" : ""}
## Notes
- sendTransaction is fast tier only${config.sendTransactionEnabled ? "" : " and currently disabled on this gateway"}.
- DAS, getProgramAccounts and other indexed methods always run on Helius and cost the same on every tier.
`;
}
