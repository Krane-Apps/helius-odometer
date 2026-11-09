import { timingSafeEqual } from "node:crypto";
import type { Context, Hono, Next } from "hono";
import { LedgerError } from "../ledger/ledger.js";
import type { AppDeps } from "../server/deps.js";
import { jsonResponse } from "../server/http.js";
import { microsToAtomic, microsToUsd, usdToMicros } from "../util/money.js";
import { readTokenHoldings, verifyTopupTransfer } from "../payments/verify.js";
import { SOLANA_MAINNET, USDC_MINTS } from "../config.js";
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
    const body = (await c.req.json().catch(() => ({}))) as { amountUsd?: number; note?: string; acknowledgeUnresolvedTopups?: boolean };
    if (typeof body.amountUsd !== "number" || !body.note) return jsonResponse(c, 400, { error: "amountUsd and note are required" });
    const wallet = c.req.param("wallet");
    // A manual credit is not linked to any top-up receipt; using one to recover a payment would let
    // the original receipt be credited again later. Point the operator at the resolve endpoint.
    const unresolved = deps.ledger.openTopupsFor(wallet);
    if (unresolved.length > 0 && body.amountUsd > 0 && !body.acknowledgeUnresolvedTopups) {
      return jsonResponse(c, 409, {
        error: "unresolved_topups",
        message:
          "This wallet may have unresolved top-ups. Resolve them with POST /admin/topups/{id}/resolve, which credits the original receipt once. Set acknowledgeUnresolvedTopups only for credits unrelated to a top-up.",
        topups: unresolved.map((t) => ({ id: t.id, status: t.status, amount: t.amount, txSignature: t.tx_signature, error: t.error })),
      });
    }
    const sign = body.amountUsd < 0 ? -1 : 1;
    try {
      const account = deps.ledger.adjust(wallet, sign * usdToMicros(Math.abs(body.amountUsd)), body.note, {
        acknowledgeUnresolvedTopups: body.acknowledgeUnresolvedTopups === true,
      });
      deps.logger.info("admin adjustment", { wallet: account.wallet, amountUsd: body.amountUsd, note: body.note });
      return c.json(accountView(deps, account.wallet));
    } catch (err) {
      if (err instanceof LedgerError) return jsonResponse(c, 400, { error: err.code, message: err.message });
      throw err;
    }
  });

  app.get("/admin/topups", (c) => c.json({ topups: deps.ledger.listTopups({ status: c.req.query("status"), limit: 200 }) }));

  app.get("/admin/topups/:id", (c) => {
    const topup = deps.ledger.getTopup(c.req.param("id"));
    return topup ? c.json({ topup }) : jsonResponse(c, 404, { error: "not_found" });
  });

  /** On-chain evidence for a top-up: did payTo receive the asset, from whom, at finalized? */
  app.get("/admin/topups/:id/verify", async (c) => {
    const topup = deps.ledger.getTopup(c.req.param("id"));
    if (!topup) return jsonResponse(c, 404, { error: "not_found" });
    const signature = c.req.query("txSignature") ?? topup.tx_signature;
    if (!signature) return jsonResponse(c, 400, { error: "txSignature_required", message: "No signature is recorded; pass ?txSignature=" });
    const evidence = await verifyTopupTransfer(deps.pool, { signature, payTo: deps.config.payTo, asset: deps.config.paymentAsset });
    const expectedAtomic = microsToAtomic(topup.amount, deps.config.paymentAssetDecimals).toString();
    return c.json({
      topup,
      evidence,
      expectedAtomic,
      matches: evidence.found && evidence.finalized && evidence.success && evidence.receivedAtomic === expectedAtomic,
    });
  });

  /**
   * Resolves an unresolved top-up on its original receipt: credit it once (with
   * on-chain evidence unless forced) or reject it. Replays and late completions
   * of the same payload or signature can never credit it again.
   */
  app.post("/admin/topups/:id/resolve", async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as {
      action?: string;
      txSignature?: string;
      wallet?: string;
      note?: string;
      force?: boolean;
    };
    const topup = deps.ledger.getTopup(id);
    if (!topup) return jsonResponse(c, 404, { error: "not_found" });
    if (!body.note?.trim()) return jsonResponse(c, 400, { error: "note_required" });
    if (topup.asset !== deps.config.paymentAsset || topup.network !== deps.config.network) {
      return jsonResponse(c, 409, { error: "asset_mismatch", message: "This top-up was for a different asset or network than the gateway's" });
    }
    try {
      if (body.action === "reject") {
        const res = deps.ledger.resolveTopup({ topupId: id, action: "reject", note: body.note });
        deps.logger.info("top-up rejected by operator", { topup: id, note: body.note });
        return c.json(res);
      }
      if (body.action !== "credit") return jsonResponse(c, 400, { error: "action must be credit or reject" });
      const signature = body.txSignature ?? topup.tx_signature;
      if (!signature) return jsonResponse(c, 400, { error: "txSignature_required" });
      let wallet = body.wallet;
      let evidence;
      if (!body.force) {
        evidence = await verifyTopupTransfer(deps.pool, { signature, payTo: deps.config.payTo, asset: deps.config.paymentAsset });
        const expectedAtomic = microsToAtomic(topup.amount, deps.config.paymentAssetDecimals).toString();
        if (!evidence.found || !evidence.finalized || !evidence.success) {
          return jsonResponse(c, 409, { error: "evidence_insufficient", message: "The transfer is not finalized and successful on-chain", evidence });
        }
        if (evidence.receivedAtomic !== expectedAtomic) {
          return jsonResponse(c, 409, { error: "amount_mismatch", expectedAtomic, evidence });
        }
        if (wallet && evidence.payer && wallet !== evidence.payer) return jsonResponse(c, 409, { error: "payer_mismatch", evidence });
        wallet = wallet ?? evidence.payer;
      }
      if (!wallet) return jsonResponse(c, 400, { error: "wallet_required", message: "The payer could not be determined; pass wallet" });
      const res = deps.ledger.resolveTopup({ topupId: id, action: "credit", wallet, txSignature: signature, note: body.note });
      deps.logger.warn("top-up credited by operator", { topup: id, wallet, signature, forced: !!body.force, note: body.note });
      return c.json({ ...res, evidence });
    } catch (err) {
      if (err instanceof LedgerError) return jsonResponse(c, 409, { error: err.code, message: err.message });
      throw err;
    }
  });

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

  /**
   * Pre-deposit readiness: the launch checks from the 2026-11-09 review that the
   * gateway can verify itself. "fail" means do not take deposits.
   */
  app.get("/admin/readiness", async (c) => {
    type Check = { name: string; status: "pass" | "warn" | "fail"; detail: string };
    const checks: Check[] = [];
    const add = (name: string, status: Check["status"], detail: string) => checks.push({ name, status, detail });
    const { config, ledger } = deps;

    add(
      "facilitator",
      deps.payments.initialized ? "pass" : "fail",
      deps.payments.initialized ? "facilitator capabilities loaded" : `facilitator not synced: ${deps.payments.lastInitError ?? "pending"}`,
    );
    if (config.network !== SOLANA_MAINNET) add("network", "warn", `${config.network} is not Solana mainnet: a test deployment`);
    else if (config.paymentAsset !== USDC_MINTS[SOLANA_MAINNET]) add("network", "warn", "mainnet with a non-USDC payment asset");
    else add("network", "pass", "Solana mainnet, USDC");
    add("storage", config.databasePath === ":memory:" ? "fail" : "pass", config.databasePath === ":memory:" ? "in-memory ledger loses balances on restart" : config.databasePath);
    add("session_secret", config.sessionSecretGenerated ? "fail" : "pass", config.sessionSecretGenerated ? "SESSION_SECRET not set; sessions die on restart" : "set");
    add("alerts", deps.alerter.configured ? "pass" : "warn", deps.alerter.configured ? "ALERT_WEBHOOK_URL set" : "alerts only reach logs; set ALERT_WEBHOOK_URL");
    const lock = ledger.db.prepare("SELECT owner FROM instance_lock WHERE id = 1").get() as { owner: string } | undefined;
    add("writer_lock", lock?.owner === deps.writerOwner ? "pass" : "fail", lock ? `held by ${lock.owner}` : "not held: start() was not called");

    const report = ledger.reconcile();
    add("ledger_arithmetic", report.arithmeticOk ? "pass" : "fail", report.arithmeticOk ? "balances match their journal" : "mismatch: see POST /admin/reconcile");
    add(
      "unresolved_topups",
      report.unresolvedTopups.count === 0 ? "pass" : "fail",
      report.unresolvedTopups.count === 0
        ? "none"
        : `${report.unresolvedTopups.count} top-up(s), ${microsToUsd(report.unresolvedTopups.amountMicros)} USD, need review`,
    );

    const holdings = await readTokenHoldings(deps.pool, { owner: config.payTo, mint: config.paymentAsset });
    if (!holdings.ok) {
      add("custody", "fail", `could not verify custody (${holdings.error}); retry, or check the upstreams`);
    } else if (holdings.accounts === 0) {
      add("custody", "fail", "PAYTO_ADDRESS has no token account for the payment asset; top-ups would fail");
    } else if (holdings.associatedAccount === "missing") {
      add("custody", "fail", "PAYTO_ADDRESS has no associated token account for the payment asset; x402 payments go to it, so top-ups would fail");
    } else {
      const liabilitiesAtomic = microsToAtomic(report.liabilitiesMicros, config.paymentAssetDecimals);
      add(
        "custody",
        holdings.amountAtomic >= liabilitiesAtomic ? "pass" : "fail",
        `operator holds ${holdings.amountAtomic} atomic units (confirmed); owes agents ${liabilitiesAtomic} (balances plus pending refunds)`,
      );
    }
    if (config.bazaarEnabled) add("public_listing", "warn", "Bazaar discovery is on: facilitators may list this service publicly");
    if (config.sendTransactionEnabled) add("send_transaction", "warn", "sendTransaction is enabled: confirm Helius permits fronting its staked path");
    if (/helius/i.test(config.serviceName)) add("branding", "warn", "the public name includes Helius; set SERVICE_NAME to a neutral name until branding is approved");

    return c.json({ ready: !checks.some((k) => k.status === "fail"), checks, reconcile: report });
  });
}
