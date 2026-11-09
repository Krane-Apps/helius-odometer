import { afterEach, describe, expect, it } from "vitest";
import { startMockRpc, type MockRpc } from "../helpers/mock-rpc.js";
import { buildRouter } from "../helpers/router-fixture.js";
import { Pricing, type PricingOptions, type Tier } from "../../src/pricing/pricing.js";
import type { JsonRpcRequest } from "../../src/routing/jsonrpc.js";
import type { RouteContext } from "../../src/routing/router.js";

const pricing = new Pricing();
const opts: PricingOptions = {
  enabledTiers: new Set<Tier>(["economy", "standard", "fast"]),
  sendTransactionEnabled: true,
  heliusAvailable: true,
};
const W = "Agent11111111111111111111111111111111111111";

function req(method: string, params?: unknown[]): JsonRpcRequest {
  return { jsonrpc: "2.0", id: 7, method, params };
}
function ctx(tier: Tier, ms = 5000): RouteContext {
  return { wallet: W, tier, requestId: "r1", deadline: Date.now() + ms };
}
async function run(f: ReturnType<typeof buildRouter>, tier: Tier, r: JsonRpcRequest, c = ctx(tier)) {
  const q = pricing.priceMethod(tier, r.method, opts);
  if (q.reject) throw new Error(`rejected: ${q.reject.message}`);
  return f.router.execute(r, { index: 0, ...q }, c);
}

describe("Router", () => {
  const servers: MockRpc[] = [];
  const mock = async (...args: Parameters<typeof startMockRpc>) => {
    const s = await startMockRpc(...args);
    servers.push(s);
    return s;
  };
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });

  it("serves economy reads from the public pool and keeps the client id", async () => {
    const pub = await mock(() => ({ result: 4242 }));
    const hel = await mock(() => ({ result: 1 }));
    const f = buildRouter({ publics: [{ id: "p1", url: pub.url }], helius: { url: hel.url } });
    const out = await run(f, "economy", req("getSlot"));
    expect(out.response).toEqual({ jsonrpc: "2.0", id: 7, result: 4242 });
    expect(out).toMatchObject({ billable: true, upstreamClass: "public", upstreamId: "p1", escalated: false });
    expect(hel.calls).toHaveLength(0);
  });

  it("never falls back to Helius on the economy tier and does not bill the failure", async () => {
    const pub = await mock(() => ({ status: 500, raw: "boom" }));
    const hel = await mock(() => ({ result: 1 }));
    const f = buildRouter({ publics: [{ id: "p1", url: pub.url }], helius: { url: hel.url } });
    const out = await run(f, "economy", req("getSlot"));
    expect(out.billable).toBe(false);
    expect("error" in out.response && out.response.error.code).toBe(-32061);
    expect(hel.calls).toHaveLength(0);
  });

  it("escalates standard reads to Helius on 429 and cools the public upstream", async () => {
    const pub = await mock(() => ({ status: 429, headers: { "retry-after": "3" }, raw: "{}" }));
    const hel = await mock(() => ({ result: 99 }));
    const f = buildRouter({ publics: [{ id: "p1", url: pub.url }], helius: { url: hel.url } });
    const out = await run(f, "standard", req("getSlot"));
    expect(out).toMatchObject({ billable: true, upstreamClass: "helius", escalated: true });
    expect(out.attempts.map((a) => a.outcome)).toEqual(["rate-limited", "ok"]);
    expect(f.publics[0]!.isCooling()).toBe(true);
    // While cooling, the next standard call goes straight to Helius.
    const again = await run(f, "standard", req("getSlot"));
    expect(again.attempts).toHaveLength(1);
    expect(pub.calls).toHaveLength(1);
  });

  it("escalates standard reads when the public attempt times out", async () => {
    const pub = await mock(() => ({ result: 1, delayMs: 800 }));
    const hel = await mock(() => ({ result: 2 }));
    const f = buildRouter({ publics: [{ id: "p1", url: pub.url }], helius: { url: hel.url } });
    const out = await run(f, "standard", req("getSlot"));
    expect(out).toMatchObject({ upstreamClass: "helius", escalated: true });
    expect(out.attempts[0]!.outcome).toBe("timeout");
  });

  it("tries a second public upstream before escalating", async () => {
    const bad = await mock(() => ({ error: { code: -32005, message: "Node is behind" } }));
    const good = await mock(() => ({ result: 5 }));
    const hel = await mock(() => ({ result: 6 }));
    const f = buildRouter({
      publics: [
        { id: "bad", url: bad.url },
        { id: "good", url: good.url },
      ],
      helius: { url: hel.url },
    });
    let sawGood = false;
    for (let i = 0; i < 6 && !sawGood; i++) {
      const out = await run(f, "standard", req("getSlot"));
      expect(out.upstreamClass).toBe("public");
      sawGood = out.upstreamId === "good";
    }
    expect(sawGood).toBe(true);
    expect(hel.calls).toHaveLength(0);
  });

  it("skips lagging upstreams", async () => {
    const lagging = await mock(() => ({ result: 1 }));
    const fresh = await mock(() => ({ result: 2 }));
    const f = buildRouter({
      publics: [
        { id: "lagging", url: lagging.url },
        { id: "fresh", url: fresh.url },
      ],
      maxSlotLag: 50,
    });
    f.publics[0]!.observeSlot(1000);
    f.publics[1]!.observeSlot(1200);
    for (let i = 0; i < 5; i++) expect((await run(f, "economy", req("getSlot"))).upstreamId).toBe("fresh");
    expect(lagging.calls).toHaveLength(0);
  });

  it("sends Helius-only methods to Helius on every tier", async () => {
    const pub = await mock(() => ({ result: "public" }));
    const hel = await mock((m) => (m === "getAsset" ? { result: { id: "asset" } } : { result: null }));
    const f = buildRouter({ publics: [{ id: "p1", url: pub.url }], helius: { url: hel.url } });
    for (const tier of ["economy", "standard", "fast"] as const) {
      const out = await run(f, tier, { jsonrpc: "2.0", id: 1, method: "getAsset", params: { id: "x" } as never });
      expect(out).toMatchObject({ upstreamClass: "helius", billable: true });
    }
    expect(pub.calls).toHaveLength(0);
  });

  it("bills client errors without retrying them", async () => {
    const pub = await mock(() => ({ error: { code: -32602, message: "Invalid param: WrongSize" } }));
    const hel = await mock(() => ({ result: 1 }));
    const f = buildRouter({ publics: [{ id: "p1", url: pub.url }], helius: { url: hel.url } });
    const out = await run(f, "standard", req("getBalance", ["bad"]));
    expect(out.billable).toBe(true);
    expect("error" in out.response && out.response.error.code).toBe(-32602);
    expect(hel.calls).toHaveLength(0);
  });

  it("learns methods a public provider does not serve and escalates", async () => {
    const pub = await mock(() => ({ error: { code: -32601, message: "Method not found" } }));
    const hel = await mock(() => ({ result: [] }));
    const f = buildRouter({ publics: [{ id: "p1", url: pub.url }], helius: { url: hel.url } });
    expect((await run(f, "standard", req("getRecentPrioritizationFees"))).upstreamClass).toBe("helius");
    expect(f.publics[0]!.serves("getRecentPrioritizationFees")).toBe(false);
    await run(f, "standard", req("getRecentPrioritizationFees"));
    expect(pub.calls).toHaveLength(1);
  });

  it("ejects an upstream after repeated failures and readmits it after successful probes", async () => {
    let healthy = false;
    const pub = await mock(() => (healthy ? { result: 10 } : { status: 503, raw: "down" }));
    const f = buildRouter({ publics: [{ id: "p1", url: pub.url }], router: { maxPublicAttempts: 1 } });
    for (let i = 0; i < 3; i++) await run(f, "economy", req("getSlot"));
    expect(f.publics[0]!.isEjected()).toBe(true);
    const before = pub.calls.length;
    expect((await run(f, "economy", req("getSlot"))).billable).toBe(false);
    expect(pub.calls.length).toBe(before);
    healthy = true;
    await f.pool.probe(f.publics[0]!);
    await f.pool.probe(f.publics[0]!);
    expect(f.publics[0]!.isEjected()).toBe(false);
    expect((await run(f, "economy", req("getSlot"))).billable).toBe(true);
  });

  it("injects the tier commitment and a minContextSlot floor from the wallet's high-water mark", async () => {
    const pub = await mock((m, params) => {
      if (m === "getBalance") return { result: { context: { slot: 5000 }, value: 1 } };
      return { result: null, params } as never;
    });
    const f = buildRouter({ publics: [{ id: "p1", url: pub.url }] });
    await run(f, "economy", req("getBalance", ["Addr"]));
    expect(pub.calls[0]!.params).toEqual(["Addr", { commitment: "confirmed" }]);
    const second = await run(f, "economy", req("getBalance", ["Addr"]));
    expect(pub.calls[1]!.params).toEqual(["Addr", { commitment: "confirmed", minContextSlot: 4996 }]);
    expect(second.injected).toEqual({ commitment: "confirmed", minContextSlot: 4996 });
    // Explicit caller values always win.
    await run(f, "economy", req("getBalance", ["Addr", { commitment: "finalized", minContextSlot: 1 }]));
    expect(pub.calls[2]!.params).toEqual(["Addr", { commitment: "finalized", minContextSlot: 1 }]);
  });

  it("retries elsewhere when an upstream has not reached the minimum context slot", async () => {
    const behind = await mock(() => ({ error: { code: -32016, message: "Minimum context slot has not been reached" } }));
    const ahead = await mock(() => ({ result: { context: { slot: 9000 }, value: 3 } }));
    const f = buildRouter({
      publics: [
        { id: "behind", url: behind.url },
        { id: "ahead", url: ahead.url },
      ],
    });
    f.hwm.observe(W, "confirmed", 8990);
    let served = 0;
    for (let i = 0; i < 4; i++) {
      const out = await run(f, "economy", req("getBalance", ["A"]));
      if (out.billable) served++;
      expect(out.upstreamId === "ahead" || !out.billable).toBe(true);
    }
    expect(served).toBe(4);
  });

  it("caches finalized getTransaction results", async () => {
    const pub = await mock(() => ({ result: { slot: 1, meta: {} } }));
    const f = buildRouter({ publics: [{ id: "p1", url: pub.url }] });
    const a = await run(f, "economy", req("getTransaction", ["sig", { maxSupportedTransactionVersion: 0 }]));
    const b = await run(f, "economy", req("getTransaction", ["sig", { maxSupportedTransactionVersion: 0 }]));
    expect(a.upstreamClass).toBe("public");
    expect(b).toMatchObject({ upstreamClass: "cache", billable: true });
    expect(pub.calls).toHaveLength(1);
    // Confirmed reads are mutable and never cached.
    await run(f, "economy", req("getTransaction", ["sig", { commitment: "confirmed" }]));
    await run(f, "economy", req("getTransaction", ["sig", { commitment: "confirmed" }]));
    expect(pub.calls).toHaveLength(3);
  });

  it("does not cache null results", async () => {
    const pub = await mock(() => ({ result: null }));
    const f = buildRouter({ publics: [{ id: "p1", url: pub.url }] });
    await run(f, "economy", req("getTransaction", ["missing"]));
    await run(f, "economy", req("getTransaction", ["missing"]));
    expect(pub.calls).toHaveLength(2);
  });

  it("sends transactions to Helius once, pins follow-up reads, and never retries on timeout", async () => {
    const pub = await mock(() => ({ result: { context: { slot: 1 }, value: [null] } }));
    let sendDelay = 0;
    const hel = await mock((m) => {
      if (m === "sendTransaction") return { result: "5ig", delayMs: sendDelay };
      return { result: { context: { slot: 2 }, value: [{ confirmationStatus: "confirmed" }] } };
    });
    const f = buildRouter({ publics: [{ id: "p1", url: pub.url }], helius: { url: hel.url } });
    const sent = await run(f, "fast", req("sendTransaction", ["AQ==", { encoding: "base64" }]));
    expect(sent).toMatchObject({ billable: true, upstreamClass: "helius" });
    const status = await run(f, "standard", req("getSignatureStatuses", [["5ig"]]));
    expect(status).toMatchObject({ upstreamClass: "helius", sticky: true });
    expect(pub.calls).toHaveLength(0);

    sendDelay = 1500;
    const timedOut = await run(f, "fast", req("sendTransaction", ["AQ=="]), ctx("fast", 1000));
    expect(timedOut.billable).toBe(false);
    expect("error" in timedOut.response && timedOut.response.error.code).toBe(-32063);
    expect(hel.callsFor("sendTransaction")).toHaveLength(2);
  });

  it("returns 429 when the Helius rate limit is exhausted", async () => {
    const hel = await mock(() => ({ result: { id: 1 } }));
    const f = buildRouter({ publics: [], helius: { url: hel.url, heavyRps: 1 } });
    const ok = await run(f, "fast", { jsonrpc: "2.0", id: 1, method: "getAsset", params: { id: "a" } as never });
    expect(ok.billable).toBe(true);
    const limited = await run(f, "fast", { jsonrpc: "2.0", id: 2, method: "getAsset", params: { id: "b" } as never });
    expect(limited).toMatchObject({ billable: false, httpStatusHint: 429 });
  });

  it("routes sendTransaction through Sender when requested", async () => {
    const hel = await mock(() => ({ result: "rpc" }));
    const snd = await mock(() => ({ result: "sender-sig" }));
    const f = buildRouter({ publics: [], helius: { url: hel.url }, sender: { url: snd.url } });
    const out = await run(f, "fast", req("sendTransaction", ["AQ==", { skipPreflight: true }]), {
      ...ctx("fast"),
      sendVia: "sender",
    });
    expect(out).toMatchObject({ upstreamClass: "sender", billable: true });
    expect(hel.calls).toHaveLength(0);
  });
});
