import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import { FacilitatorTimeoutError } from "@x402/core/server";
import { startMockRpc, type MockRpc } from "../helpers/mock-rpc.js";
import { FakeFacilitator } from "../helpers/fake-facilitator.js";
import { startApp, TEST_MINT, TEST_PAYTO, type StartedApp } from "../helpers/app-fixture.js";
import { SOLANA_DEVNET } from "../../src/config.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (r: Response | Promise<Response>): Promise<any> => (await r).json();
const ADMIN = { authorization: "Bearer admin-token-0123456789", "content-type": "application/json" };

/** On-chain evidence served by the mock upstream for getTransaction(signature). */
const chain = new Map<string, { payer: string; received: string; err?: unknown }>();
function txFor(sig: string) {
  const ev = chain.get(sig);
  if (!ev) return null;
  return {
    slot: 4242,
    blockTime: 1_762_000_000,
    meta: {
      err: ev.err ?? null,
      preTokenBalances: [
        { accountIndex: 1, mint: TEST_MINT, owner: ev.payer, uiTokenAmount: { amount: "9000000" } },
        { accountIndex: 2, mint: TEST_MINT, owner: TEST_PAYTO, uiTokenAmount: { amount: "0" } },
      ],
      postTokenBalances: [
        { accountIndex: 1, mint: TEST_MINT, owner: ev.payer, uiTokenAmount: { amount: String(9_000_000 - Number(ev.received)) } },
        { accountIndex: 2, mint: TEST_MINT, owner: TEST_PAYTO, uiTokenAmount: { amount: ev.received } },
      ],
    },
  };
}

describe("top-up recovery over HTTP", () => {
  let pub: MockRpc;
  let facilitator: FakeFacilitator;
  let gw: StartedApp;
  let pr: PaymentRequired;
  let n = 0;

  const rpc = (headers: Record<string, string> = {}) =>
    fetch(`${gw.url}/v1/rpc/economy`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot" }),
    });
  const payment = (wallet: string, nonce = `n${++n}`) =>
    encodePaymentSignatureHeader({ x402Version: 2, accepted: pr.accepts[0]!, resource: pr.resource, payload: { transaction: `fake:${wallet}:${nonce}` } });
  const topupFor = (wallet: string) => gw.odometer.deps.ledger.listTopups({ limit: 500 }).find((t) => t.wallet === wallet) as Record<string, unknown> | undefined;

  beforeAll(async () => {
    pub = await startMockRpc((method, params) => {
      if (method === "getTransaction") return { result: txFor((params as string[])[0]!) };
      if (method === "getLatestBlockhash") {
        return { result: { context: { slot: 1 }, value: { blockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi", lastValidBlockHeight: 9 } } };
      }
      return { result: 1 };
    });
    facilitator = new FakeFacilitator(SOLANA_DEVNET);
    gw = await startApp({ PUBLIC_UPSTREAMS: pub.url, WALLET_RPS: "1000", IP_RPS: "1000" }, facilitator);
    pr = decodePaymentRequiredHeader((await rpc()).headers.get("payment-required")!);
  });
  afterAll(async () => {
    await gw.close();
    await pub.close();
  });

  it("freezes a timed-out settlement for review and refuses to resend it", async () => {
    const wallet = "Timeout1111111111111111111111111111111111111";
    const header = payment(wallet, "timeout");
    facilitator.throwOnNextSettle = new FacilitatorTimeoutError("settle", 60_000);
    const res = await rpc({ "payment-signature": header });
    expect(res.status).toBe(502);
    expect((await json(res)).error).toBe("settlement_unknown");
    const row = gw.odometer.deps.ledger.listTopups({ status: "needs_review" })[0] as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(gw.odometer.deps.ledger.available(wallet)).toBe(0);
    const calls = facilitator.settleCalls;
    const retry = await rpc({ "payment-signature": header });
    expect(retry.status).toBe(402);
    expect((await json(retry)).reason).toBe("payment_under_review");
    expect(facilitator.settleCalls).toBe(calls);
  });

  it("records a broadcast-but-unconfirmed settlement with its signature", async () => {
    const wallet = "Broadcast111111111111111111111111111111111111";
    facilitator.failNextSettleWithTransaction = { reason: "transaction_confirmation_timeout", transaction: "SigBroadcast111" };
    const res = await rpc({ "payment-signature": payment(wallet) });
    expect(res.status).toBe(402);
    expect(topupFor(wallet)).toMatchObject({ status: "needs_review", tx_signature: "SigBroadcast111" });
  });

  it("credits a reviewed top-up once, with on-chain evidence, and never again", async () => {
    const wallet = "Evidence11111111111111111111111111111111111";
    facilitator.failNextSettleWithTransaction = { reason: "transaction_confirmation_timeout", transaction: "SigEvidence111" };
    await rpc({ "payment-signature": payment(wallet, "evidence") });
    const id = String(topupFor(wallet)!.id);
    chain.set("SigEvidence111", { payer: wallet, received: "1000000" });

    const verify = await json(fetch(`${gw.url}/admin/topups/${id}/verify`, { headers: ADMIN }));
    expect(verify).toMatchObject({ matches: true, evidence: { found: true, finalized: true, success: true, payer: wallet } });

    // A generic manual credit is refused while the top-up is unresolved.
    const adjust = await fetch(`${gw.url}/admin/accounts/${wallet}/adjust`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ amountUsd: 1, note: "recovery" }),
    });
    expect(adjust.status).toBe(409);
    expect((await json(adjust)).error).toBe("unresolved_topups");

    const resolve = await fetch(`${gw.url}/admin/topups/${id}/resolve`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ action: "credit", note: "verified on-chain" }),
    });
    expect(resolve.status).toBe(200);
    expect(gw.odometer.deps.ledger.available(wallet)).toBe(1_000_000);

    const again = await fetch(`${gw.url}/admin/topups/${id}/resolve`, { method: "POST", headers: ADMIN, body: JSON.stringify({ action: "credit", note: "again" }) });
    expect(again.status).toBe(409);
    const row = gw.odometer.deps.ledger.getTopup(id)!;
    const late = gw.odometer.deps.ledger.completeTopup({
      payloadHash: row.payload_hash,
      wallet,
      txSignature: "SigEvidence111",
      amount: row.amount,
      network: row.network,
      asset: row.asset,
    });
    expect(late.credited).toBe(false);
    expect(gw.odometer.deps.ledger.available(wallet)).toBe(1_000_000);
  });

  it("refuses to credit without matching evidence", async () => {
    const wallet = "Mismatch11111111111111111111111111111111111";
    facilitator.failNextSettleWithTransaction = { reason: "transaction_confirmation_timeout", transaction: "SigShort111" };
    await rpc({ "payment-signature": payment(wallet) });
    const id = String(topupFor(wallet)!.id);
    chain.set("SigShort111", { payer: wallet, received: "500000" });
    const short = await fetch(`${gw.url}/admin/topups/${id}/resolve`, { method: "POST", headers: ADMIN, body: JSON.stringify({ action: "credit", note: "x" }) });
    expect(short.status).toBe(409);
    expect((await json(short)).error).toBe("amount_mismatch");
    chain.set("SigShort111", { payer: wallet, received: "1000000", err: { InstructionError: [0, "Custom"] } });
    const failed = await fetch(`${gw.url}/admin/topups/${id}/resolve`, { method: "POST", headers: ADMIN, body: JSON.stringify({ action: "credit", note: "x" }) });
    expect((await json(failed)).error).toBe("evidence_insufficient");
    expect(gw.odometer.deps.ledger.available(wallet)).toBe(0);
  });

  it("lets an operator reject a top-up, which stays frozen against resends", async () => {
    const wallet = "Rejected11111111111111111111111111111111111";
    const header = payment(wallet, "reject-me");
    facilitator.throwOnNextSettle = new FacilitatorTimeoutError("settle", 60_000);
    await rpc({ "payment-signature": header });
    const id = String(topupFor(wallet)?.id ?? gw.odometer.deps.ledger.listTopups({ status: "needs_review" }).at(-1)!.id);
    const res = await fetch(`${gw.url}/admin/topups/${id}/resolve`, { method: "POST", headers: ADMIN, body: JSON.stringify({ action: "reject", note: "no transfer on-chain" }) });
    expect(res.status).toBe(200);
    const retry = await rpc({ "payment-signature": header });
    expect((await json(retry)).reason).toBe("payment_under_review");
  });
});
