import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { PaymentRequired } from "@x402/core/types";
import { startMockRpc, type MockRpc } from "../helpers/mock-rpc.js";
import { FakeFacilitator } from "../helpers/fake-facilitator.js";
import { startApp, type StartedApp } from "../helpers/app-fixture.js";
import { SOLANA_DEVNET } from "../../src/config.js";

/**
 * Review finding 3 (2026-11-09): a funded remote MCP session kept spending
 * after the wallet revoked its sessions. These tests pin the fixed behavior.
 */
type ToolResult = { isError?: boolean; content: Array<{ text: string }>; structuredContent?: unknown; _meta?: Record<string, unknown> };

let nonce = 0;
async function connect(url: string, opts: { headers?: Record<string, string>; sessionId?: string } = {}) {
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
    requestInit: opts.headers ? { headers: opts.headers } : undefined,
    sessionId: opts.sessionId,
  });
  const client = new Client({ name: "regression", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}
const call = (client: Client, args: Record<string, unknown> = { method: "getSlot" }, meta?: Record<string, unknown>) =>
  client.callTool({ name: "solana_rpc_economy", arguments: args, ...(meta ? { _meta: meta } : {}) }) as Promise<ToolResult>;

async function pay(client: Client, wallet: string, acceptIndex = 0, args: Record<string, unknown> = { method: "getSlot" }) {
  const challenge = await call(client, args);
  expect(challenge.isError).toBe(true);
  const pr = challenge.structuredContent as PaymentRequired;
  return call(client, args, {
    "x402/payment": { x402Version: 2, accepted: pr.accepts[acceptIndex], resource: pr.resource, payload: { transaction: `fake:${wallet}:${++nonce}` } },
  });
}
const isPaymentRequired = (r: ToolResult) => r.isError === true && Array.isArray((r.structuredContent as PaymentRequired | undefined)?.accepts);
const body = (r: ToolResult) => JSON.parse(r.content[0]!.text) as Record<string, unknown>;

describe("remote MCP spending authority", () => {
  let pub: MockRpc;
  let gw: StartedApp;

  beforeAll(async () => {
    pub = await startMockRpc(() => ({ result: 7 }));
    gw = await startApp(
      { PUBLIC_UPSTREAMS: pub.url, TOPUP_OPTIONS_USD: "0.00003,1", TRUST_PROXY: "true", WALLET_RPS: "1000", REMOTE_MCP_SESSIONS_PER_MINUTE: "1000" },
      new FakeFacilitator(SOLANA_DEVNET),
    );
  });
  afterAll(async () => {
    await gw.close();
    await pub.close();
  });

  it("revoking a wallet terminates its funded MCP sessions (the reviewed bypass)", async () => {
    const wallet = "McpRevoke11111111111111111111111111111111111";
    const { client } = await connect(gw.url);
    expect((await pay(client, wallet, 1)).isError).toBe(false);
    expect((await call(client)).isError).toBe(false);
    const before = gw.odometer.deps.ledger.available(wallet);
    const token = gw.odometer.deps.sessions.issue(wallet).token;
    const revoke = await fetch(`${gw.url}/v1/session/revoke`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    expect(revoke.status).toBe(200);
    const after = await call(client).then(
      (r) => ({ r }),
      (e: unknown) => ({ e }),
    );
    expect("e" in after || isPaymentRequired(after.r)).toBe(true);
    expect(gw.odometer.deps.ledger.available(wallet)).toBe(before);
    await client.close().catch(() => {});
  });

  it("a revocation applied straight to the ledger still unbinds on the next call", async () => {
    const wallet = "McpEpoch111111111111111111111111111111111111";
    const { client } = await connect(gw.url);
    expect((await pay(client, wallet, 1)).isError).toBe(false);
    gw.odometer.deps.ledger.bumpSessionEpoch(wallet);
    expect(isPaymentRequired(await call(client))).toBe(true);
    await client.close();
  });

  it("a bare session id can spend only what that session paid, not the wallet's balance", async () => {
    const wallet = "McpVoucher11111111111111111111111111111111111";
    gw.odometer.deps.ledger.adjust(wallet, 5_000_000, "funded over HTTP");
    const { client } = await connect(gw.url);
    expect((await pay(client, wallet, 0)).isError).toBe(false); // pays $0.00003, spends $0.00001
    expect((await call(client)).isError).toBe(false);
    expect((await call(client)).isError).toBe(false);
    expect(isPaymentRequired(await call(client))).toBe(true);
    expect(gw.odometer.deps.ledger.available(wallet)).toBe(5_000_000);
    await client.close();
  });

  it("simultaneous calls cannot exceed what the session paid or reach older wallet funds", async () => {
    const wallet = "McpRace1111111111111111111111111111111111111";
    gw.odometer.deps.ledger.adjust(wallet, 5_000_000, "funded over HTTP");
    const { client } = await connect(gw.url);
    expect((await pay(client, wallet, 0)).isError).toBe(false); // pays $0.00003, spends $0.00001: two calls left
    const results = await Promise.all(Array.from({ length: 12 }, () => call(client)));
    expect(results.filter((r) => r.isError === false)).toHaveLength(2);
    expect(results.filter(isPaymentRequired)).toHaveLength(10);
    expect(gw.odometer.deps.ledger.available(wallet)).toBe(5_000_000);
    expect(gw.odometer.deps.ledger.getAccount(wallet)!.reserved).toBe(0);
    // The allowance is spent, not negative or stuck: the next call is asked to pay.
    expect(isPaymentRequired(await call(client))).toBe(true);
    await client.close();
  });

  it("a failed call returns its hold to the session allowance", async () => {
    const wallet = "McpRefund11111111111111111111111111111111111";
    gw.odometer.deps.ledger.adjust(wallet, 5_000_000, "funded over HTTP");
    const { client } = await connect(gw.url);
    expect((await pay(client, wallet, 0)).isError).toBe(false); // two calls left
    pub.setHandler(() => ({ status: 503, raw: "down" }));
    try {
      const failed = await Promise.all(Array.from({ length: 4 }, () => call(client)));
      expect(failed.every((r) => r.isError === true)).toBe(true);
    } finally {
      pub.setHandler(() => ({ result: 7 }));
    }
    // Nothing was charged, so both paid-for calls are still available.
    const after = await Promise.all([call(client), call(client), call(client)]);
    expect(after.filter((r) => r.isError === false)).toHaveLength(2);
    expect(gw.odometer.deps.ledger.available(wallet)).toBe(5_000_000);
    await client.close();
  });

  it("a session token on the MCP transport spends the wallet balance, and dies with revocation", async () => {
    const wallet = "McpToken111111111111111111111111111111111111";
    gw.odometer.deps.ledger.adjust(wallet, 1_000_000, "funded over HTTP");
    const token = gw.odometer.deps.sessions.issue(wallet).token;
    const { client } = await connect(gw.url, { headers: { authorization: `Bearer ${token}` } });
    const ok = await call(client);
    expect(ok.isError).toBe(false);
    expect(body(ok).cost).toMatchObject({ chargedUsd: "0.00001" });
    gw.odometer.deps.ledger.bumpSessionEpoch(wallet);
    const refused = await call(client);
    expect(refused.isError).toBe(true);
    expect(body(refused)).toMatchObject({ error: "session_invalid", reason: "revoked" });
    await client.close();
  });

  it("a session id replayed from another IP cannot spend, and does not break the original client", async () => {
    const wallet = "McpIp11111111111111111111111111111111111111";
    const a = await connect(gw.url, { headers: { "x-forwarded-for": "10.0.0.1" } });
    expect((await pay(a.client, wallet, 1)).isError).toBe(false);
    const b = await connect(gw.url, { headers: { "x-forwarded-for": "10.9.9.9" }, sessionId: a.transport.sessionId });
    expect(isPaymentRequired(await call(b.client))).toBe(true);
    expect((await call(a.client)).isError).toBe(false);
    await a.client.close();
  });

  it("honours maxPriceUsd and idempotencyKey like the HTTP API", async () => {
    const wallet = "McpParity1111111111111111111111111111111111";
    const { client } = await connect(gw.url);
    expect((await pay(client, wallet, 1)).isError).toBe(false);
    const before = gw.odometer.deps.ledger.available(wallet);
    const pricey = await call(client, { method: "getSlot", maxPriceUsd: 0.000001 });
    expect(body(pricey).error).toBe("price_exceeds_max");
    expect(gw.odometer.deps.ledger.available(wallet)).toBe(before);
    const first = await call(client, { method: "getSlot", idempotencyKey: "k-1" });
    const replay = await call(client, { method: "getSlot", idempotencyKey: "k-1" });
    expect(replay._meta?.["odometer/idempotentReplay"]).toBe(true);
    expect(body(replay).requestId).toBe(body(first).requestId);
    expect(gw.odometer.deps.ledger.available(wallet)).toBe(before - 10);
    const mismatch = await call(client, { method: "getBlockHeight", idempotencyKey: "k-1" });
    expect(body(mismatch).error).toBe("idempotency_mismatch");
    await client.close();
  });
});

describe("remote MCP session lifetime and limits", () => {
  let pub: MockRpc;
  let gw: StartedApp;

  beforeAll(async () => {
    pub = await startMockRpc(() => ({ result: 7 }));
    gw = await startApp(
      { PUBLIC_UPSTREAMS: pub.url, REMOTE_MCP_SESSION_TTL_SECONDS: "1", REMOTE_MCP_SESSIONS_PER_MINUTE: "3", WALLET_RPS: "1000" },
      new FakeFacilitator(SOLANA_DEVNET),
    );
  });
  afterAll(async () => {
    await gw.close();
    await pub.close();
  });

  it("a spending binding expires absolutely, even while the session stays active", async () => {
    const wallet = "McpExpiry1111111111111111111111111111111111";
    const { client } = await connect(gw.url);
    expect((await pay(client, wallet)).isError).toBe(false);
    await new Promise((r) => setTimeout(r, 1100));
    expect(isPaymentRequired(await call(client))).toBe(true);
    await client.close();
  });

  it("limits how many new sessions one address may open", async () => {
    const opened: Client[] = [];
    let refused = false;
    for (let i = 0; i < 4; i++) {
      try {
        opened.push((await connect(gw.url)).client);
      } catch {
        refused = true;
      }
    }
    expect(refused).toBe(true);
    await Promise.all(opened.map((c) => c.close()));
  });
});
