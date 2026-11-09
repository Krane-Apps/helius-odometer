import { afterEach, describe, expect, it } from "vitest";
import { startMockRpc, type MockRpc } from "../helpers/mock-rpc.js";
import { buildRouter } from "../helpers/router-fixture.js";
import { Pricing, type Tier } from "../../src/pricing/pricing.js";

const pricing = new Pricing();
const opts = { enabledTiers: new Set<Tier>(["fast"]), sendTransactionEnabled: true, heliusAvailable: true };

describe("Router sendTransaction preflight", () => {
  const servers: MockRpc[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });

  async function send(params: unknown[]) {
    const hel = await startMockRpc(() => ({ result: "sig" }));
    servers.push(hel);
    const f = buildRouter({ publics: [], helius: { url: hel.url } });
    const q = pricing.priceMethod("fast", "sendTransaction", opts);
    const out = await f.router.execute({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params }, { index: 0, ...q }, {
      wallet: "w",
      tier: "fast",
      requestId: "r",
      deadline: Date.now() + 5000,
    });
    return { out, sentParams: hel.calls[0]!.params };
  }

  it("defaults preflightCommitment to confirmed when the caller set none", async () => {
    const { out, sentParams } = await send(["AQ==", { encoding: "base64" }]);
    expect(sentParams).toEqual(["AQ==", { encoding: "base64", preflightCommitment: "confirmed" }]);
    expect(out.injected).toEqual({ commitment: "confirmed" });
  });

  it("adds a config object when the caller passed only the transaction", async () => {
    const { sentParams } = await send(["base58tx"]);
    expect(sentParams).toEqual(["base58tx", { preflightCommitment: "confirmed" }]);
  });

  it("never overrides an explicit choice or a skipped preflight", async () => {
    expect((await send(["AQ==", { preflightCommitment: "finalized" }])).sentParams).toEqual([
      "AQ==",
      { preflightCommitment: "finalized" },
    ]);
    const skipped = await send(["AQ==", { skipPreflight: true }]);
    expect(skipped.sentParams).toEqual(["AQ==", { skipPreflight: true }]);
    expect(skipped.out.injected).toBeUndefined();
  });
});
