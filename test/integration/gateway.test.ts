import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import { createSIWxPayload, encodeSIWxHeader, type SIWxExtension } from "@x402/extensions/sign-in-with-x";
import { startMockRpc, type MockRpc } from "../helpers/mock-rpc.js";
import { FakeFacilitator, FAKE_FEE_PAYER } from "../helpers/fake-facilitator.js";
import { startApp, TEST_MINT, TEST_PAYTO, type StartedApp } from "../helpers/app-fixture.js";
import { SOLANA_DEVNET } from "../../src/config.js";

const BLOCKHASH = "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi";

function upstreamHandler(tag: string) {
  return (method: string) => {
    switch (method) {
      case "getSlot":
        return { result: 1_000 };
      case "getLatestBlockhash":
        return { result: { context: { slot: 1_000 }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 2_000 } } };
      case "getBalance":
        return { result: { context: { slot: 1_000 }, value: 5 } };
      case "getAccountInfo":
        return { result: { context: { slot: 1_000 }, value: null } };
      case "getAsset":
        return { result: { id: "asset", source: tag } };
      default:
        return { result: tag };
    }
  };
}

let nonce = 0;
function payHeader(pr: PaymentRequired, wallet: string, index = 0, txNonce = String(++nonce)): string {
  return encodePaymentSignatureHeader({
    x402Version: 2,
    resource: pr.resource,
    accepted: pr.accepts[index]!,
    payload: { transaction: `fake:${wallet}:${txNonce}` },
  });
}

async function rpc(url: string, tier: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${url}/v1/rpc/${tier}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { res, status: res.status, body: text ? JSON.parse(text) : undefined, h: (n: string) => res.headers.get(n) };
}

const getSlot = { jsonrpc: "2.0", id: 1, method: "getSlot" };

describe("gateway (integration, fake facilitator)", () => {
  let pub: MockRpc;
  let hel: MockRpc;
  let facilitator: FakeFacilitator;
  let gw: StartedApp;
  let agent: KeyPairSigner;

  beforeAll(async () => {
    pub = await startMockRpc(upstreamHandler("public"));
    hel = await startMockRpc(upstreamHandler("helius"));
    facilitator = new FakeFacilitator(SOLANA_DEVNET);
    gw = await startApp(
      {
        PUBLIC_UPSTREAMS: JSON.stringify([{ id: "pub", url: pub.url, rps: 0 }]),
        HELIUS_RPC_URL: hel.url,
        WALLET_RPS: "1000",
        IP_RPS: "1000",
      },
      facilitator,
    );
    agent = await generateKeyPairSigner();
  });
  afterAll(async () => {
    await gw.close();
    await pub.close();
    await hel.close();
  });

  it("serves the free discovery endpoints", async () => {
    const index = await (await fetch(gw.url)).json();
    expect(index.tiers.map((t: { tier: string }) => t.tier).sort()).toEqual(["economy", "fast", "standard"]);
    const pricing = await (await fetch(`${gw.url}/pricing`)).json();
    expect(pricing.methods.find((m: { method: string }) => m.method === "getAsset").priceUsd).toEqual({
      economy: "0.0002",
      standard: "0.0002",
      fast: "0.0002",
    });
    const llms = await (await fetch(`${gw.url}/llms.txt`)).text();
    expect(llms).toContain("ask your user how important speed is");
    const wk = await (await fetch(`${gw.url}/.well-known/x402`)).json();
    expect(wk.resources.length).toBeGreaterThanOrEqual(4);
    const health = await (await fetch(`${gw.url}/health`)).json();
    expect(health).toMatchObject({ ok: true, paymentsReady: true });
  });

  it("answers an unpaid call with a 402 listing prepaid top-ups and a SIWx challenge", async () => {
    const r = await rpc(gw.url, "economy", getSlot);
    expect(r.status).toBe(402);
    const pr = decodePaymentRequiredHeader(r.h("payment-required")!);
    expect(pr.x402Version).toBe(2);
    expect(pr.resource.url).toBe(`${gw.url}/v1/rpc/economy`);
    expect(pr.accepts.map((a) => a.amount)).toEqual(["1000000", "5000000", "20000000"]);
    for (const a of pr.accepts) {
      expect(a).toMatchObject({ scheme: "exact", network: SOLANA_DEVNET, asset: TEST_MINT, payTo: TEST_PAYTO });
      expect(a.extra).toMatchObject({ paymentFlow: "upfront", feePayer: FAKE_FEE_PAYER, recentBlockhash: BLOCKHASH });
    }
    const siwx = pr.extensions?.["sign-in-with-x"] as SIWxExtension;
    expect(siwx.info.domain).toBe(new URL(gw.url).host);
    expect(siwx.supportedChains[0]).toMatchObject({ chainId: SOLANA_DEVNET, type: "ed25519" });
    expect(pr.extensions?.bazaar).toBeDefined();
    expect(r.body).toMatchObject({ error: "payment_required", topupOptionsUsd: [1, 5, 20] });
  });

  it("settles a top-up, serves the call, and issues a session that spends the balance", async () => {
    const first = await rpc(gw.url, "economy", getSlot);
    const pr = decodePaymentRequiredHeader(first.h("payment-required")!);
    const header = payHeader(pr, agent.address);
    const paid = await rpc(gw.url, "economy", getSlot, { "payment-signature": header });
    expect(paid.status).toBe(200);
    expect(paid.body).toEqual({ jsonrpc: "2.0", id: 1, result: 1000 });
    expect(paid.h("x-odometer-charged")).toBe("10");
    expect(paid.h("x-odometer-balance")).toBe("999990");
    expect(paid.h("x-odometer-wallet")).toBe(agent.address);
    const settle = decodePaymentResponseHeader(paid.h("payment-response")!);
    expect(settle).toMatchObject({ success: true, payer: agent.address });
    const token = paid.h("x-odometer-session")!;
    expect(token).toMatch(/^odo1\./);

    const settlesBefore = facilitator.settleCalls;
    const again = await rpc(gw.url, "standard", getSlot, { authorization: `Bearer ${token}` });
    expect(again.status).toBe(200);
    expect(again.h("x-odometer-charged")).toBe("30");
    expect(again.h("x-odometer-balance")).toBe("999960");
    expect(facilitator.settleCalls).toBe(settlesBefore);

    // Replaying the same signed payment never credits twice.
    const replay = await rpc(gw.url, "economy", getSlot, { "payment-signature": header });
    expect(replay.status).toBe(402);
    expect(facilitator.settleCalls).toBe(settlesBefore);
    const bal = await (await fetch(`${gw.url}/v1/balance`, { headers: { authorization: `Bearer ${token}` } })).json();
    expect(bal).toMatchObject({ wallet: agent.address, availableMicros: 999_960, totalToppedUpUsd: "1" });
    expect(gw.odometer.deps.ledger.reconcile().ok).toBe(true);
  });

  it("signs in with SIWx, enforces single-use nonces and binds to the origin", async () => {
    const challenge = (await (await fetch(`${gw.url}/v1/auth/challenge`)).json()) as SIWxExtension;
    const info = { ...challenge.info, chainId: SOLANA_DEVNET, type: "ed25519" as const };
    const payload = await createSIWxPayload(info, agent, `${gw.url}/v1/auth/session`);
    const header = encodeSIWxHeader(payload);
    const ok = await fetch(`${gw.url}/v1/auth/session`, { method: "POST", headers: { "sign-in-with-x": header } });
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.wallet).toBe(agent.address);
    expect(body.sessionToken).toMatch(/^odo1\./);
    const replay = await fetch(`${gw.url}/v1/auth/session`, { method: "POST", headers: { "sign-in-with-x": header } });
    expect(replay.status).toBe(401);
    expect((await replay.json()).error).toBe("invalid_siwx_nonce");

    // A proof minted for another origin is refused.
    const evilInfo = { ...info, domain: "evil.example", uri: "https://evil.example/v1/auth/session", nonce: "f".repeat(32) };
    const evil = encodeSIWxHeader(await createSIWxPayload(evilInfo, agent, "https://evil.example/v1/auth/session"));
    const refused = await fetch(`${gw.url}/v1/auth/session`, { method: "POST", headers: { "sign-in-with-x": evil } });
    expect(refused.status).toBe(401);
    expect((await refused.json()).error).toBe("invalid_siwx_domain_mismatch");
  });

  it("accepts SIWx directly on an RPC call for a funded wallet", async () => {
    const r402 = await rpc(gw.url, "economy", getSlot);
    const siwx = decodePaymentRequiredHeader(r402.h("payment-required")!).extensions!["sign-in-with-x"] as SIWxExtension;
    const proof = await createSIWxPayload({ ...siwx.info, chainId: SOLANA_DEVNET, type: "ed25519" }, agent, `${gw.url}/v1/rpc/economy`);
    const r = await rpc(gw.url, "economy", getSlot, { "sign-in-with-x": encodeSIWxHeader(proof) });
    expect(r.status).toBe(200);
    expect(r.h("x-odometer-session")).toMatch(/^odo1\./);
  });

  it("tells an authenticated but empty wallet it needs a top-up", async () => {
    const empty = await generateKeyPairSigner();
    const challenge = (await (await fetch(`${gw.url}/v1/auth/challenge`)).json()) as SIWxExtension;
    const proof = await createSIWxPayload({ ...challenge.info, chainId: SOLANA_DEVNET, type: "ed25519" }, empty, `${gw.url}/v1/auth/session`);
    const session = await (await fetch(`${gw.url}/v1/auth/session`, { method: "POST", headers: { "sign-in-with-x": encodeSIWxHeader(proof) } })).json();
    const r = await rpc(gw.url, "economy", getSlot, { authorization: `Bearer ${session.sessionToken}` });
    expect(r.status).toBe(402);
    expect(r.body).toMatchObject({ error: "insufficient_balance", wallet: empty.address, availableMicros: 0, priceMicros: 10 });
  });

  async function fundedSession(usdIndex = 0): Promise<{ token: string; wallet: KeyPairSigner }> {
    const wallet = await generateKeyPairSigner();
    const first = await rpc(gw.url, "economy", getSlot);
    const pr = decodePaymentRequiredHeader(first.h("payment-required")!);
    const paid = await rpc(gw.url, "economy", getSlot, { "payment-signature": payHeader(pr, wallet.address, usdIndex) });
    expect(paid.status).toBe(200);
    return { token: paid.h("x-odometer-session")!, wallet };
  }

  it("bills batches per item and never charges rejected items", async () => {
    const { token } = await fundedSession();
    const before = gw.odometer.deps.ledger.available((await whoami(token)).wallet);
    const r = await rpc(
      gw.url,
      "economy",
      [getSlot, { jsonrpc: "2.0", id: 2, method: "getAsset", params: { id: "x" } }, { jsonrpc: "2.0", id: 3, method: "eth_call" }],
      { authorization: `Bearer ${token}` },
    );
    expect(r.status).toBe(200);
    expect(r.body[0]).toMatchObject({ id: 1, result: 1000 });
    expect(r.body[1]).toMatchObject({ id: 2, result: { source: "helius" } });
    expect(r.body[2]).toMatchObject({ id: 3, error: { code: -32601 } });
    expect(r.h("x-odometer-charged")).toBe("210");
    expect(r.h("x-odometer-upstream-class")).toBe("public,helius");
    expect(gw.odometer.deps.ledger.available((await whoami(token)).wallet)).toBe(before - 210);
  });

  it("refuses requests that cannot be served without asking for payment", async () => {
    const r = await rpc(gw.url, "economy", { jsonrpc: "2.0", id: 9, method: "sendTransaction", params: ["AQ=="] });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe(-32053);
    const missing = await rpc(gw.url, "turbo", getSlot);
    expect(missing.status).toBe(404);
  });

  it("honours X-Odometer-Max-Price", async () => {
    const { token } = await fundedSession();
    const r = await rpc(gw.url, "fast", getSlot, { authorization: `Bearer ${token}`, "x-odometer-max-price": "0.00001" });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("price_exceeds_max");
  });

  it("replays idempotent requests without charging twice", async () => {
    const { token } = await fundedSession();
    const headers = { authorization: `Bearer ${token}`, "idempotency-key": "abc-123" };
    const a = await rpc(gw.url, "fast", getSlot, headers);
    const b = await rpc(gw.url, "fast", getSlot, headers);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.h("x-odometer-idempotent-replay")).toBe("true");
    expect(b.h("x-odometer-charged")).toBe("0");
    expect(b.body).toEqual(a.body);
    const c = await rpc(gw.url, "fast", { ...getSlot, id: 2 }, headers);
    expect(c.status).toBe(422);
  });

  it("does not charge for upstream failures and escalates the standard tier", async () => {
    const { token } = await fundedSession();
    pub.setHandler(() => ({ status: 503, raw: "down" }));
    try {
      const wallet = (await whoami(token)).wallet;
      const before = gw.odometer.deps.ledger.available(wallet);
      const econ = await rpc(gw.url, "economy", getSlot, { authorization: `Bearer ${token}` });
      expect(econ.status).toBe(503);
      expect(econ.body.error.code).toBe(-32061);
      expect(econ.h("x-odometer-charged")).toBe("0");
      expect(gw.odometer.deps.ledger.available(wallet)).toBe(before);
      const std = await rpc(gw.url, "standard", getSlot, { authorization: `Bearer ${token}` });
      expect(std.status).toBe(200);
      expect(std.h("x-odometer-upstream-class")).toBe("helius");
      expect(std.h("x-odometer-charged")).toBe("30");
    } finally {
      pub.setHandler(upstreamHandler("public"));
      gw.odometer.deps.pool.publics[0]!.ejectedUntil = 0;
      gw.odometer.deps.pool.publics[0]!.consecutiveFailures = 0;
    }
  });

  it("supports explicit top-ups, refunds and the admin API", async () => {
    const wallet = await generateKeyPairSigner();
    const challenge = await fetch(`${gw.url}/v1/topup`, { method: "POST" });
    expect(challenge.status).toBe(402);
    const pr = decodePaymentRequiredHeader(challenge.headers.get("payment-required")!);
    const topup = await fetch(`${gw.url}/v1/topup`, { method: "POST", headers: { "payment-signature": payHeader(pr, wallet.address, 1) } });
    expect(topup.status).toBe(200);
    const t = await topup.json();
    expect(t).toMatchObject({ wallet: wallet.address, availableUsd: "5" });
    const auth = { authorization: `Bearer ${t.sessionToken}`, "content-type": "application/json" };

    const refund = await fetch(`${gw.url}/v1/refunds`, { method: "POST", headers: auth, body: JSON.stringify({ amountUsd: 2 }) });
    expect(refund.status).toBe(201);
    const { refund: rf } = await refund.json();
    expect(rf).toMatchObject({ amount: 2_000_000, destination: wallet.address, status: "requested" });

    const admin = { authorization: "Bearer admin-token-0123456789", "content-type": "application/json" };
    expect((await fetch(`${gw.url}/admin/stats`)).status).toBe(401);
    const stats = await (await fetch(`${gw.url}/admin/stats`, { headers: admin })).json();
    expect(stats.ledger.totals.fundedWallets).toBeGreaterThan(0);
    const paid = await fetch(`${gw.url}/admin/refunds/${rf.id}`, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ status: "paid", txSignature: "refund-sig" }),
    });
    expect((await paid.json()).refund.status).toBe("paid");
    const recon = await (await fetch(`${gw.url}/admin/reconcile`, { method: "POST", headers: admin })).json();
    expect(recon.ok).toBe(true);
    const bal = await (await fetch(`${gw.url}/v1/balance`, { headers: auth })).json();
    expect(bal.availableUsd).toBe("3");
  });

  it("recovers from a failed settlement", async () => {
    const wallet = await generateKeyPairSigner();
    const first = await rpc(gw.url, "economy", getSlot);
    const pr = decodePaymentRequiredHeader(first.h("payment-required")!);
    facilitator.failNextSettle = "transaction_failed";
    const failed = await rpc(gw.url, "economy", getSlot, { "payment-signature": payHeader(pr, wallet.address, 0, "fail-1") });
    expect(failed.status).toBe(402);
    expect(gw.odometer.deps.ledger.available(wallet.address)).toBe(0);
    const ok = await rpc(gw.url, "economy", getSlot, { "payment-signature": payHeader(pr, wallet.address, 0, "fail-1") });
    expect(ok.status).toBe(200);
    expect(gw.odometer.deps.ledger.available(wallet.address)).toBe(999_990);
  });

  it("revokes sessions", async () => {
    const { token } = await fundedSession();
    const revoke = await fetch(`${gw.url}/v1/session/revoke`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    expect(revoke.status).toBe(200);
    const r = await rpc(gw.url, "economy", getSlot, { authorization: `Bearer ${token}` });
    expect(r.status).toBe(402);
    expect(r.body).toMatchObject({ error: "session_invalid", detail: "revoked" });
  });

  it("serves only payment-building calls on the free bootstrap endpoint", async () => {
    const call = (method: string, params?: unknown[]) =>
      fetch(`${gw.url}/v1/bootstrap`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
    expect((await call("getLatestBlockhash")).status).toBe(200);
    expect((await call("getAccountInfo", [TEST_MINT, { encoding: "base64" }])).status).toBe(200);
    expect((await call("getAccountInfo", ["SomeoneElse11111111111111111111111111111111"])).status).toBe(403);
    expect((await call("getBalance", [TEST_PAYTO])).status).toBe(403);
  });

  async function whoami(token: string): Promise<{ wallet: string }> {
    return (await fetch(`${gw.url}/v1/balance`, { headers: { authorization: `Bearer ${token}` } })).json();
  }
});

describe("gateway limits", () => {
  let pub: MockRpc;
  let gw: StartedApp;
  beforeAll(async () => {
    pub = await startMockRpc(upstreamHandler("public"));
    gw = await startApp(
      {
        PUBLIC_UPSTREAMS: pub.url,
        TOPUP_OPTIONS_USD: "0.00005",
        WALLET_DAILY_CAP_USD: "0.00003",
        WALLET_RPS: "1000",
      },
      new FakeFacilitator(SOLANA_DEVNET),
    );
  });
  afterAll(async () => {
    await gw.close();
    await pub.close();
  });

  it("only enables tiers the configured upstreams can serve", async () => {
    const index = await (await fetch(gw.url)).json();
    expect(index.tiers.map((t: { tier: string }) => t.tier)).toEqual(["economy"]);
    const r = await rpc(gw.url, "economy", { jsonrpc: "2.0", id: 1, method: "getAsset", params: { id: "x" } });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe(-32055);
  });

  it("enforces the daily cap with a 429 and no charge", async () => {
    const wallet = await generateKeyPairSigner();
    const first = await rpc(gw.url, "economy", getSlot);
    const pr = decodePaymentRequiredHeader(first.h("payment-required")!);
    const paid = await rpc(gw.url, "economy", getSlot, { "payment-signature": payHeader(pr, wallet.address) });
    expect(paid.status).toBe(200);
    const auth = { authorization: `Bearer ${paid.h("x-odometer-session")}` };
    expect((await rpc(gw.url, "economy", getSlot, auth)).status).toBe(200);
    expect((await rpc(gw.url, "economy", getSlot, auth)).status).toBe(200);
    const capped = await rpc(gw.url, "economy", getSlot, auth);
    expect(capped.status).toBe(429);
    expect(capped.body.error).toBe("daily_cap_exceeded");
    expect(Number(capped.h("retry-after"))).toBeGreaterThan(0);
    expect(gw.odometer.deps.ledger.available(wallet.address)).toBe(20);
  });
});
