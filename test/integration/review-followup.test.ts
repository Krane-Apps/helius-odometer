import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { PaymentRequired } from "@x402/core/types";
import { startMockRpc, type MockRpc } from "../helpers/mock-rpc.js";
import { FakeFacilitator } from "../helpers/fake-facilitator.js";
import { startApp, type StartedApp } from "../helpers/app-fixture.js";
import { SOLANA_DEVNET } from "../../src/config.js";

/**
 * Follow-up review findings: a REST call billed when the operator's Helius key
 * was rejected, a paid-for response that could not be recovered once the
 * balance was empty, and a wallet with spending stopped being asked to deposit.
 */
type ToolResult = { isError?: boolean; content: Array<{ text: string }>; structuredContent?: unknown; _meta?: Record<string, unknown> };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (r: Response | Promise<Response>): Promise<any> => (await r).json();
const isPaymentRequired = (r: ToolResult) => r.isError === true && Array.isArray((r.structuredContent as PaymentRequired | undefined)?.accepts);
const toolBody = (r: ToolResult) => JSON.parse(r.content[0]!.text) as Record<string, unknown>;
const PRICE = 10; // economy getSlot, in micros

describe("follow-up review findings", () => {
  let rpcMock: MockRpc;
  let rest: Server;
  let restReply: { status: number; body: string } = { status: 200, body: "[]" };
  let restCalls = 0;
  let gw: StartedApp;

  const session = (wallet: string) => ({ authorization: `Bearer ${gw.odometer.deps.sessions.issue(wallet).token}` });
  const rpc = (headers: Record<string, string>) =>
    fetch(`${gw.url}/v1/rpc/economy`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot" }),
    });
  const parse = (headers: Record<string, string>) =>
    fetch(`${gw.url}/v1/helius/v0/transactions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ transactions: ["sig1"] }),
    });
  async function mcp(wallet: string) {
    const transport = new StreamableHTTPClientTransport(new URL(`${gw.url}/mcp`), { requestInit: { headers: session(wallet) } });
    const client = new Client({ name: "followup", version: "1.0.0" });
    await client.connect(transport);
    const call = (args: Record<string, unknown>) => client.callTool({ name: "solana_rpc_economy", arguments: args }) as Promise<ToolResult>;
    return { client, call };
  }

  beforeAll(async () => {
    rpcMock = await startMockRpc(() => ({ result: 7 }));
    rest = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        restCalls += 1;
        res.writeHead(restReply.status, { "content-type": "application/json" }).end(restReply.body);
      });
    });
    await new Promise<void>((resolve) => rest.listen(0, "127.0.0.1", resolve));
    gw = await startApp(
      {
        PUBLIC_UPSTREAMS: rpcMock.url,
        HELIUS_RPC_URL: rpcMock.url,
        HELIUS_API_KEY: "operator-secret-key",
        HELIUS_API_BASE: `http://127.0.0.1:${(rest.address() as AddressInfo).port}`,
        WALLET_RPS: "1000",
        IP_RPS: "1000",
        REMOTE_MCP_SESSIONS_PER_MINUTE: "1000",
      },
      new FakeFacilitator(SOLANA_DEVNET),
    );
  });
  afterAll(async () => {
    await gw.close();
    await rpcMock.close();
    await new Promise<void>((resolve) => rest.close(() => resolve()));
  });

  describe("REST calls when Helius rejects the operator's key", () => {
    for (const status of [401, 403]) {
      it(`does not charge the customer for a Helius ${status}`, async () => {
        const wallet = `RestAuth${status}1111111111111111111111111111111111`;
        gw.odometer.deps.ledger.adjust(wallet, 1_000_000, "test funding");
        restReply = { status, body: JSON.stringify({ error: "invalid api key provided: operator-secret-key" }) };
        const res = await parse(session(wallet));
        expect(res.status).toBe(502);
        expect(res.headers.get("x-odometer-charged")).toBe("0");
        const text = await res.text();
        expect(text).toContain("upstream_auth_failed");
        expect(text).not.toContain("operator-secret-key");
        expect(gw.odometer.deps.ledger.available(wallet)).toBe(1_000_000);
      });
    }

    it("still charges for answers the request itself caused", async () => {
      const wallet = "RestBilled11111111111111111111111111111111111";
      gw.odometer.deps.ledger.adjust(wallet, 1_000_000, "test funding");
      restReply = { status: 200, body: "[]" };
      const ok = await parse(session(wallet));
      expect(ok.status).toBe(200);
      const price = Number(ok.headers.get("x-odometer-charged"));
      expect(price).toBeGreaterThan(0);
      restReply = { status: 400, body: JSON.stringify({ error: "invalid signature" }) };
      const bad = await parse(session(wallet));
      expect(bad.status).toBe(400);
      expect(Number(bad.headers.get("x-odometer-charged"))).toBe(price);
    });
  });

  describe("recovering an already-paid response with an empty balance", () => {
    it("replays the stored HTTP response instead of asking for a top-up", async () => {
      const wallet = "ReplayHttp11111111111111111111111111111111111";
      gw.odometer.deps.ledger.adjust(wallet, PRICE, "exactly one call");
      const headers = { ...session(wallet), "idempotency-key": "paid-once" };
      const first = await rpc(headers);
      expect(first.status).toBe(200);
      expect(gw.odometer.deps.ledger.available(wallet)).toBe(0);

      const again = await rpc(headers);
      expect(again.status).toBe(200);
      expect(again.headers.get("x-odometer-idempotent-replay")).toBe("true");
      expect(again.headers.get("x-odometer-charged")).toBe("0");
      expect(await again.json()).toEqual(await first.json());
      // A different request under the same key is still a mismatch, and a new key still needs funds.
      const other = await fetch(`${gw.url}/v1/rpc/economy`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBlockHeight" }),
      });
      expect(other.status).toBe(402);
      expect((await rpc({ ...session(wallet), "idempotency-key": "never-paid" })).status).toBe(402);
    });

    it("replays the stored MCP result instead of asking for a top-up", async () => {
      const wallet = "ReplayMcp111111111111111111111111111111111111";
      gw.odometer.deps.ledger.adjust(wallet, PRICE, "exactly one call");
      const { client, call } = await mcp(wallet);
      const first = await call({ method: "getSlot", idempotencyKey: "paid-once" });
      expect(first.isError).toBe(false);
      expect(gw.odometer.deps.ledger.available(wallet)).toBe(0);
      const again = await call({ method: "getSlot", idempotencyKey: "paid-once" });
      expect(isPaymentRequired(again)).toBe(false);
      expect(again._meta?.["odometer/idempotentReplay"]).toBe(true);
      expect(toolBody(again).result).toEqual(toolBody(first).result);
      expect(isPaymentRequired(await call({ method: "getSlot", idempotencyKey: "never-paid" }))).toBe(true);
      await client.close();
    });
  });

  describe("a wallet with spending stopped", () => {
    it("is refused over HTTP without being asked to deposit", async () => {
      const wallet = "StoppedHttp1111111111111111111111111111111111";
      gw.odometer.deps.ledger.setDailyCap(wallet, 0);
      const empty = await rpc(session(wallet));
      expect(empty.status).toBe(429);
      expect(empty.headers.get("payment-required")).toBeNull();
      expect((await json(empty)).error).toBe("daily_cap_exceeded");
      // Lifting the stop brings the normal deposit prompt back.
      gw.odometer.deps.ledger.setDailyCap(wallet, null);
      expect((await rpc(session(wallet))).status).toBe(402);
    });

    it("is refused over HTTP when its cap is used up and its balance is too low", async () => {
      const wallet = "CapUsedHttp1111111111111111111111111111111111";
      gw.odometer.deps.ledger.adjust(wallet, PRICE, "exactly one call");
      gw.odometer.deps.ledger.setDailyCap(wallet, PRICE);
      expect((await rpc(session(wallet))).status).toBe(200);
      const next = await rpc(session(wallet));
      expect(next.status).toBe(429);
      expect(next.headers.get("payment-required")).toBeNull();
    });

    it("is refused over MCP without being asked to deposit", async () => {
      const wallet = "StoppedMcp11111111111111111111111111111111111";
      gw.odometer.deps.ledger.setDailyCap(wallet, 0);
      const { client, call } = await mcp(wallet);
      const res = await call({ method: "getSlot" });
      expect(isPaymentRequired(res)).toBe(false);
      expect(res.isError).toBe(true);
      expect(toolBody(res).error).toBe("daily_cap_exceeded");
      await client.close();
    });
  });

  it("counts the REST calls it made to Helius", () => {
    expect(restCalls).toBeGreaterThan(0);
  });
});
