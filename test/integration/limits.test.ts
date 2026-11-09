import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateKeyPairSigner } from "@solana/kit";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { startMockRpc, type MockRpc } from "../helpers/mock-rpc.js";
import { FakeFacilitator } from "../helpers/fake-facilitator.js";
import { startApp, type StartedApp } from "../helpers/app-fixture.js";
import { SOLANA_DEVNET } from "../../src/config.js";

const getSlot = { jsonrpc: "2.0", id: 1, method: "getSlot" };

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${url}/v1/rpc/economy`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("rate limits", () => {
  let pub: MockRpc;
  let gw: StartedApp;

  beforeAll(async () => {
    pub = await startMockRpc((m) =>
      m === "getLatestBlockhash"
        ? { result: { context: { slot: 1 }, value: { blockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi", lastValidBlockHeight: 10 } } }
        : { result: 1 },
    );
    gw = await startApp({ PUBLIC_UPSTREAMS: pub.url, IP_RPS: "1", WALLET_RPS: "2" }, new FakeFacilitator(SOLANA_DEVNET));
  });
  afterAll(async () => {
    await gw.close();
    await pub.close();
  });

  it("limits payment challenges per IP even when a bogus credential is sent", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await post(gw.url, getSlot, { authorization: "Bearer odo1.bogus.token" });
      statuses.push(res.status);
      await res.body?.cancel();
    }
    expect(statuses.slice(0, 2)).toEqual([402, 402]);
    expect(statuses).toContain(429);
  });

  it("counts every call in a batch against the wallet's rate limit", async () => {
    // Let the IP bucket refill so the funding challenge is allowed.
    await new Promise((r) => setTimeout(r, 2100));
    const wallet = await generateKeyPairSigner();
    const challenge = await post(gw.url, getSlot);
    expect(challenge.status).toBe(402);
    const pr = decodePaymentRequiredHeader(challenge.headers.get("payment-required")!);
    const header = encodePaymentSignatureHeader({
      x402Version: 2,
      resource: pr.resource,
      accepted: pr.accepts[0]!,
      payload: { transaction: `fake:${wallet.address}:limits` },
    });
    const paid = await post(gw.url, getSlot, { "payment-signature": header });
    expect(paid.status).toBe(200);
    const auth = { authorization: `Bearer ${paid.headers.get("x-odometer-session")}` };
    await new Promise((r) => setTimeout(r, 2100));
    const batch = [1, 2, 3, 4].map((id) => ({ ...getSlot, id }));
    const first = await post(gw.url, batch, auth);
    expect(first.status).toBe(200);
    const second = await post(gw.url, batch, auth);
    expect(second.status).toBe(429);
    expect(second.headers.get("x-odometer-charged")).toBeNull();
  });
});
