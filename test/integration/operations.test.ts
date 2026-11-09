import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import { FacilitatorTimeoutError } from "@x402/core/server";
import { startMockRpc, type MockRpc } from "../helpers/mock-rpc.js";
import { FAKE_FEE_PAYER, FakeFacilitator } from "../helpers/fake-facilitator.js";
import { startApp, type StartedApp } from "../helpers/app-fixture.js";
import { SOLANA_DEVNET } from "../../src/config.js";
import { associatedTokenAccounts } from "../../src/payments/verify.js";

// Real addresses (devnet USDC and a fixed operator key) so the operator's ATA can be derived.
const OPERATOR = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (r: Response | Promise<Response>): Promise<any> => (await r).json();
const ADMIN = { authorization: "Bearer admin-token-0123456789" };

/** A webhook receiver standing in for Slack or a pager bridge. */
async function startAlertSink() {
  const received: Array<{ headers: IncomingHttpHeaders; body: Record<string, unknown> }> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      received.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> });
      res.writeHead(200).end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/hook`, received, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

async function waitFor<T>(fn: () => T | undefined, ms = 3000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("operations: receipts, readiness, single writer, alerts", () => {
  let pub: MockRpc;
  let sink: Awaited<ReturnType<typeof startAlertSink>>;
  let facilitator: FakeFacilitator;
  let gw: StartedApp;
  let pr: PaymentRequired;
  let dir: string;
  let env: Record<string, string>;
  let n = 0;
  // What the operator's payTo wallet holds on-chain, as served by the mock upstream.
  let holdings = { accounts: 1, amount: "50000000", atAta: true };
  let operatorAta = "";

  const rpc = (method: string, headers: Record<string, string> = {}) =>
    fetch(`${gw.url}/v1/rpc/economy`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method }),
    });
  const payment = (wallet: string) =>
    encodePaymentSignatureHeader({ x402Version: 2, accepted: pr.accepts[0]!, resource: pr.resource, payload: { transaction: `fake:${wallet}:op${++n}` } });
  const fundedToken = async (wallet: string) => {
    const paid = await rpc("getSlot", { "payment-signature": payment(wallet) });
    expect(paid.status).toBe(200);
    return paid.headers.get("x-odometer-session")!;
  };
  const readiness = async () => {
    const body = await json(fetch(`${gw.url}/admin/readiness`, { headers: ADMIN }));
    const byName = Object.fromEntries((body.checks as Array<{ name: string; status: string; detail: string }>).map((k) => [k.name, k]));
    return { body, byName };
  };

  beforeAll(async () => {
    pub = await startMockRpc((method) => {
      if (method === "getTokenAccountsByOwner") {
        const value = Array.from({ length: holdings.accounts }, (_, i) => ({
          pubkey: holdings.atAta && i === 0 ? operatorAta : `Other${i}`,
          account: { data: { parsed: { info: { tokenAmount: { amount: holdings.amount } } } } },
        }));
        return { result: { context: { slot: 1 }, value } };
      }
      if (method === "getBlockHeight") return { status: 503, raw: "upstream down" };
      if (method === "getLatestBlockhash") {
        return { result: { context: { slot: 1 }, value: { blockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi", lastValidBlockHeight: 9 } } };
      }
      return { result: 1 };
    });
    operatorAta = (await associatedTokenAccounts(OPERATOR, USDC_DEVNET))[0]!;
    sink = await startAlertSink();
    dir = mkdtempSync(join(tmpdir(), "odometer-ops-"));
    env = {
      PUBLIC_UPSTREAMS: pub.url,
      PAYTO_ADDRESS: OPERATOR,
      PAYMENT_ASSET: USDC_DEVNET,
      DATABASE_PATH: join(dir, "ledger.db"),
      ALERT_WEBHOOK_URL: sink.url,
      ALERT_WEBHOOK_AUTH_HEADER: "Bearer sink-secret",
      WALLET_RPS: "1000",
      IP_RPS: "1000",
      MAX_PUBLIC_ATTEMPTS: "1",
    };
    facilitator = new FakeFacilitator(SOLANA_DEVNET);
    gw = await startApp(env, facilitator);
    gw.odometer.start();
    pr = decodePaymentRequiredHeader((await rpc("getSlot")).headers.get("payment-required")!);
  });
  afterAll(async () => {
    await gw.close();
    await pub.close();
    await sink.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports ready on a correctly configured deployment, with only advisory warnings", async () => {
    const unauth = await fetch(`${gw.url}/admin/readiness`);
    expect(unauth.status).toBe(401);
    const { body, byName } = await readiness();
    expect(body.ready).toBe(true);
    for (const name of ["facilitator", "storage", "session_secret", "alerts", "writer_lock", "ledger_arithmetic", "unresolved_topups", "custody"]) {
      expect(byName[name], name).toMatchObject({ status: "pass" });
    }
    expect(byName.facilitator!.detail).toBe(`synced; fee payer ${FAKE_FEE_PAYER}`);
    expect(byName.network).toMatchObject({ status: "warn" }); // devnet test deployment
    expect(byName.public_origin).toMatchObject({ status: "warn" }); // plain-HTTP test origin, allowed off mainnet
    expect(byName.branding).toMatchObject({ status: "warn" }); // default public name includes Helius
  });

  it("refuses a second gateway process on the same ledger", async () => {
    const second = await startApp(env, new FakeFacilitator(SOLANA_DEVNET));
    try {
      expect(() => second.odometer.start()).toThrow(/Another gateway process/);
    } finally {
      await second.close();
    }
    // The first process still holds the lock.
    expect((await readiness()).byName.writer_lock).toMatchObject({ status: "pass" });
  });

  it("tells an agent whether a request was charged, by idempotency key or request id", async () => {
    const wallet = "Receipt11111111111111111111111111111111111";
    const token = await fundedToken(wallet);
    const auth = { authorization: `Bearer ${token}` };

    const ok = await rpc("getSlot", { ...auth, "idempotency-key": "receipt-key-1" });
    expect(ok.status).toBe(200);
    const requestId = ok.headers.get("x-odometer-request-id")!;
    const charged = Number(ok.headers.get("x-odometer-charged"));
    expect(charged).toBeGreaterThan(0);

    const byKey = await json(fetch(`${gw.url}/v1/receipts?idempotencyKey=receipt-key-1`, { headers: auth }));
    expect(byKey.receipt).toMatchObject({ requestId, state: "charged", chargedMicros: charged, httpStatus: 200, idempotencyKey: "receipt-key-1" });
    expect(byKey.retention).toEqual({ idempotencyKeysHours: 24, requestRecordsDays: 30 });
    const byId = await json(fetch(`${gw.url}/v1/receipts?requestId=${requestId}`, { headers: auth }));
    expect(byId.receipt).toMatchObject({ requestId, state: "charged", chargedMicros: charged, tier: "economy", methods: ["getSlot"] });

    // An upstream failure is released, and the receipt says so.
    const failed = await rpc("getBlockHeight", auth);
    expect(failed.status).toBeGreaterThanOrEqual(500);
    const failedId = failed.headers.get("x-odometer-request-id")!;
    const notCharged = await json(fetch(`${gw.url}/v1/receipts?requestId=${failedId}`, { headers: auth }));
    expect(notCharged.receipt).toMatchObject({ state: "not_charged", chargedMicros: 0 });

    expect((await fetch(`${gw.url}/v1/receipts`, { headers: auth })).status).toBe(400);
    expect((await fetch(`${gw.url}/v1/receipts?requestId=req_nope`, { headers: auth })).status).toBe(404);
    expect((await fetch(`${gw.url}/v1/receipts?requestId=${requestId}`)).status).toBe(401);
    // Another wallet cannot read this wallet's receipts.
    const other = await fundedToken("Other111111111111111111111111111111111111111");
    expect((await fetch(`${gw.url}/v1/receipts?requestId=${requestId}`, { headers: { authorization: `Bearer ${other}` } })).status).toBe(404);
  });

  it("fails readiness when custody does not cover what agents are owed", async () => {
    const owed = (await readiness()).body.reconcile.liabilitiesMicros as number;
    expect(owed).toBeGreaterThan(0);
    holdings = { accounts: 1, amount: String(owed - 1), atAta: true };
    let r = await readiness();
    expect(r.body.ready).toBe(false);
    expect(r.byName.custody).toMatchObject({ status: "fail" });
    expect(r.byName.custody!.detail).toContain(`owes agents ${owed}`);

    holdings = { accounts: 0, amount: "0", atAta: false };
    r = await readiness();
    expect(r.byName.custody).toMatchObject({ status: "fail" });
    expect(r.byName.custody!.detail).toMatch(/no token account/);

    // Funds in some other token account, but none in the ATA that x402 pays into.
    holdings = { accounts: 1, amount: String(owed * 10), atAta: false };
    r = await readiness();
    expect(r.byName.custody).toMatchObject({ status: "fail" });
    expect(r.byName.custody!.detail).toMatch(/no associated token account/);

    holdings = { accounts: 1, amount: String(owed), atAta: true };
    expect((await readiness()).body.ready).toBe(true);
  });

  it("alerts the operator and fails readiness when a settlement outcome is unknown", async () => {
    facilitator.throwOnNextSettle = new FacilitatorTimeoutError("settle", 60_000);
    const res = await rpc("getSlot", { "payment-signature": payment("Unknown1111111111111111111111111111111111111") });
    expect(res.status).toBe(502);

    const alert = await waitFor(() => sink.received.find((a) => String(a.body.key).startsWith("settlement:")));
    expect(alert.headers.authorization).toBe("Bearer sink-secret");
    expect(alert.body).toMatchObject({ severity: "critical", service: "Helius Odometer" });
    expect(String(alert.body.text)).toMatch(/^\[critical\] Helius Odometer: Top-up settlement outcome unknown/);

    const r = await readiness();
    expect(r.body.ready).toBe(false);
    expect(r.byName.unresolved_topups).toMatchObject({ status: "fail" });
    expect(r.byName.ledger_arithmetic).toMatchObject({ status: "pass" });
  });
});
