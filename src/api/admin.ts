import { timingSafeEqual } from "node:crypto";
import type { Context, Hono, Next } from "hono";
import { LedgerError } from "../ledger/ledger.js";
import type { AppDeps } from "../server/deps.js";
import { jsonResponse } from "../server/http.js";
import { microsToUsd, usdToMicros } from "../util/money.js";
import { accountView } from "./public.js";

/** Operator endpoints. Disabled unless ADMIN_TOKEN is set. */
export function registerAdminRoutes(app: Hono, deps: AppDeps): void {
  const token = deps.config.adminToken;
  if (!token) return;
  const expected = Buffer.from(`Bearer ${token}`);
  const guard = async (c: Context, next: Next) => {
    const given = Buffer.from(c.req.header("authorization") ?? "");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return jsonResponse(c, 401, { error: "unauthorized" });
    }
    await next();
  };
  app.use("/admin/*", guard);

  app.get("/admin/stats", (c) => {
    const ledgerStats = deps.ledger.stats();
    const counters = deps.counters;
    const heliusCostMicros = Math.round(counters.heliusCreditsEstimate * 5); // $5 per 1M credits
    return c.json({
      since: new Date(deps.startedAt).toISOString(),
      ledger: ledgerStats,
      counters,
      economics: {
        note: "Process-lifetime estimate at the $5 per 1M credit list rate; excludes the fixed plan fee.",
        revenueUsd: microsToUsd(counters.revenueMicros),
        heliusCreditCostUsd: microsToUsd(heliusCostMicros),
        grossMarginUsd: microsToUsd(counters.revenueMicros - heliusCostMicros),
      },
      upstreams: deps.pool.snapshot(),
    });
  });

  app.get("/admin/accounts/:wallet", (c) => {
    const wallet = c.req.param("wallet");
    return c.json({
      account: accountView(deps, wallet),
      journal: deps.ledger.journal(wallet, 100),
      topups: deps.ledger.listTopups({ wallet, limit: 50 }),
      refunds: deps.ledger.listRefunds({ wallet }),
    });
  });

  app.post("/admin/accounts/:wallet/adjust", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { amountUsd?: number; note?: string };
    if (typeof body.amountUsd !== "number" || !body.note) return jsonResponse(c, 400, { error: "amountUsd and note are required" });
    const sign = body.amountUsd < 0 ? -1 : 1;
    try {
      const account = deps.ledger.adjust(c.req.param("wallet"), sign * usdToMicros(Math.abs(body.amountUsd)), body.note);
      deps.logger.info("admin adjustment", { wallet: account.wallet, amountUsd: body.amountUsd, note: body.note });
      return c.json(accountView(deps, account.wallet));
    } catch (err) {
      if (err instanceof LedgerError) return jsonResponse(c, 400, { error: err.code, message: err.message });
      throw err;
    }
  });

  app.get("/admin/topups", (c) => c.json({ topups: deps.ledger.listTopups({ status: c.req.query("status"), limit: 200 }) }));

  app.get("/admin/refunds", (c) => c.json({ refunds: deps.ledger.listRefunds({ status: c.req.query("status") }) }));

  app.post("/admin/refunds/:id", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { status?: string; txSignature?: string; note?: string };
    if (body.status !== "paid" && body.status !== "rejected") return jsonResponse(c, 400, { error: "status must be paid or rejected" });
    if (body.status === "paid" && !body.txSignature) return jsonResponse(c, 400, { error: "txSignature is required for paid refunds" });
    try {
      const refund = deps.ledger.resolveRefund(c.req.param("id"), body.status, { txSignature: body.txSignature, note: body.note });
      return c.json({ refund });
    } catch (err) {
      if (err instanceof LedgerError) return jsonResponse(c, 400, { error: err.code, message: err.message });
      throw err;
    }
  });

  app.post("/admin/reconcile", (c) => c.json(deps.ledger.reconcile()));
}
