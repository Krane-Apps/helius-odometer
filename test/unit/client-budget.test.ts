import { describe, expect, it } from "vitest";
import { generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import { OdometerClient, OdometerError } from "../../src/client/index.js";

/**
 * Review finding 2 (2026-11-09): the total-budget check ran before an awaited
 * signing call and the counter was bumped afterwards, so concurrent top-ups
 * both passed. The budget is now reserved before any await and top-ups are
 * serialized.
 */
const BASE = "http://gateway.test";
const NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const PR: PaymentRequired = {
  x402Version: 2,
  resource: { url: `${BASE}/v1/rpc/economy` },
  accepts: [
    {
      scheme: "exact",
      network: NETWORK,
      amount: "1000000",
      asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      payTo: "PayTo111111111111111111111111111111111111111",
      maxTimeoutSeconds: 120,
      extra: {},
    },
  ],
};

interface Internals {
  payer: { createPaymentPayload: (pr: unknown) => Promise<unknown> };
  http: { encodePaymentSignatureHeader: (p: unknown) => Record<string, string> };
  paymentHeaders: (pr: PaymentRequired, usd?: number) => Promise<Record<string, string>>;
}
const internals = (c: OdometerClient) => c as unknown as Internals;

function mockSigning(client: OdometerClient, onSign?: () => void, delayMs = 20) {
  let signed = 0;
  internals(client).payer.createPaymentPayload = async () => {
    onSign?.();
    await new Promise((r) => setTimeout(r, delayMs));
    signed += 1;
    return {};
  };
  internals(client).http.encodePaymentSignatureHeader = () => ({ "PAYMENT-SIGNATURE": "signed" });
  return () => signed;
}

/** A tiny fake gateway: SIWx sign-in, then 402 until a payment arrives, then 200. */
function fakeGateway(opts: { failPaidRequest?: boolean } = {}) {
  let funded = false;
  let paymentsReceived = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = new Headers(init?.headers);
    if (url.endsWith("/v1/auth/challenge")) {
      const now = Date.now();
      return Response.json({
        info: {
          domain: "gateway.test",
          uri: `${BASE}/v1/auth/session`,
          version: "1",
          nonce: "a".repeat(32),
          issuedAt: new Date(now).toISOString(),
          expirationTime: new Date(now + 300_000).toISOString(),
          resources: [`${BASE}/v1/auth/session`],
        },
        supportedChains: [{ chainId: NETWORK, type: "ed25519" }],
        schema: {},
      });
    }
    if (url.endsWith("/v1/auth/session")) {
      return Response.json({ sessionToken: "odo1.fake.token", expiresAt: new Date(Date.now() + 600_000).toISOString(), availableMicros: 0 });
    }
    if (headers.get("payment-signature")) {
      paymentsReceived += 1;
      if (opts.failPaidRequest) throw new TypeError("fetch failed: connection reset");
      funded = true;
      return Response.json({ jsonrpc: "2.0", id: 1, result: "paid" }, { headers: { "x-odometer-charged": "10" } });
    }
    if (funded) return Response.json({ jsonrpc: "2.0", id: 1, result: "from-balance" }, { headers: { "x-odometer-charged": "10" } });
    return new Response(JSON.stringify({ error: "insufficient_balance" }), {
      status: 402,
      headers: { "content-type": "application/json", "payment-required": encodePaymentRequiredHeader(PR) },
    });
  }) as typeof fetch;
  return { fetchImpl, payments: () => paymentsReceived };
}

async function client(signer: KeyPairSigner, extra: Partial<ConstructorParameters<typeof OdometerClient>[0]> = {}) {
  return new OdometerClient({ baseUrl: BASE, signer, maxTopupUsd: 1, maxSpendUsd: 1, ...extra });
}

describe("client top-up budget", () => {
  it("never authorizes more than maxSpendUsd under concurrency (the reviewed race)", async () => {
    const c = await client(await generateKeyPairSigner());
    const signed = mockSigning(c);
    const results = await Promise.allSettled([internals(c).paymentHeaders(PR), internals(c).paymentHeaders(PR)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(OdometerError);
    expect((rejected.reason as OdometerError).code).toBe("spend_limit_reached");
    expect(c.spentOnTopupsMicros).toBe(1_000_000);
    expect(signed()).toBe(1);
  });

  it("returns the reservation when signing fails, because no authorization exists", async () => {
    const totals: number[] = [];
    const c = await client(await generateKeyPairSigner(), { onSpendChange: (t) => totals.push(t) });
    internals(c).payer.createPaymentPayload = async () => {
      throw new Error("wallet refused to sign");
    };
    await expect(internals(c).paymentHeaders(PR)).rejects.toThrow("wallet refused to sign");
    expect(c.spentOnTopupsMicros).toBe(0);
    expect(totals).toEqual([1_000_000, 0]);
  });

  it("persists the reserved total before the payment is signed", async () => {
    const totals: number[] = [];
    const c = await client(await generateKeyPairSigner(), { onSpendChange: (t) => totals.push(t) });
    let totalSeenWhileSigning: number | undefined;
    mockSigning(c, () => (totalSeenWhileSigning = totals.at(-1)));
    await internals(c).paymentHeaders(PR);
    expect(totalSeenWhileSigning).toBe(1_000_000);
  });

  it("keeps a signed payment counted when its response is lost", async () => {
    const gw = fakeGateway({ failPaidRequest: true });
    const c = await client(await generateKeyPairSigner(), { fetch: gw.fetchImpl, maxSpendUsd: 2 });
    mockSigning(c);
    await expect(c.rpc("getSlot")).rejects.toThrow(/connection reset/);
    expect(gw.payments()).toBe(1);
    expect(c.spentOnTopupsMicros).toBe(1_000_000);
  });

  it("restores a durable total so the limit survives a restart", async () => {
    const c = await client(await generateKeyPairSigner(), { initialSpentMicros: 1_000_000 });
    mockSigning(c);
    await expect(internals(c).paymentHeaders(PR)).rejects.toMatchObject({ code: "spend_limit_reached" });
  });

  it("serializes top-ups: concurrent calls pay once and the rest use the new balance", async () => {
    const gw = fakeGateway();
    const c = await client(await generateKeyPairSigner(), { fetch: gw.fetchImpl, maxSpendUsd: 5 });
    const signed = mockSigning(c);
    const results = await Promise.all([c.rpc("getSlot"), c.rpc("getSlot"), c.rpc("getSlot")]);
    expect(results.map((r) => r.result).sort()).toEqual(["from-balance", "from-balance", "paid"]);
    expect(signed()).toBe(1);
    expect(gw.payments()).toBe(1);
    expect(c.spentOnTopupsMicros).toBe(1_000_000);
  });

  it("signs nothing when the gateway says the call is forbidden, not unfunded", async () => {
    const signer = await generateKeyPairSigner();
    const gateway = fakeGateway();
    // A wallet with spending stopped: the gateway refuses with 429 and offers no payment.
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/v1/auth/")) return gateway.fetchImpl(input, init);
      return Response.json({ error: "daily_cap_exceeded", message: "Spending is stopped for this wallet; not charged" }, { status: 429 });
    }) as typeof fetch;
    const c = await client(signer, { fetch: fetchImpl });
    const signed = mockSigning(c);
    await expect(c.rpc("getSlot")).rejects.toMatchObject({ code: "daily_cap_exceeded" });
    expect(signed()).toBe(0);
    expect(gateway.payments()).toBe(0);
  });
});
