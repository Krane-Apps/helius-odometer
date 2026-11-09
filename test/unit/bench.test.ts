import { afterEach, describe, expect, it } from "vitest";
import { startMockRpc, type MockRpc } from "../helpers/mock-rpc.js";
import { parseCalls, percentile, redact, runBench, toMarkdown } from "../../src/bench/bench.js";

describe("bench", () => {
  const servers: MockRpc[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });

  it("measures latency, rate limits and slot lag per upstream", async () => {
    let n = 0;
    const fresh = await startMockRpc((m) => (m === "getSlot" ? { result: 1_000 } : { result: { context: { slot: 1_000 }, value: 1 } }));
    const flaky = await startMockRpc((m) => {
      n += 1;
      if (m === "getSlot") return { result: 980 };
      return n % 2 === 0 ? { status: 429, raw: "{}" } : { result: { context: { slot: 980 }, value: 1 }, delayMs: 20 };
    });
    servers.push(fresh, flaky);
    const report = await runBench({
      targets: [
        { id: "fresh", url: fresh.url },
        { id: "flaky", url: flaky.url },
      ],
      calls: parseCalls(["getBalance"], "Addr1111111111111111111111111111111111111111"),
      durationMs: 1200,
      rps: 20,
      timeoutMs: 1000,
      slotPollMs: 200,
    });
    const freshR = report.targets.find((t) => t.id === "fresh")!;
    const flakyR = report.targets.find((t) => t.id === "flaky")!;
    expect(freshR.methods[0]!.count).toBeGreaterThan(10);
    expect(freshR.methods[0]!.rateLimited).toBe(0);
    expect(flakyR.methods[0]!.rateLimited).toBeGreaterThan(0);
    expect(flakyR.methods[0]!.p50Ms).toBeGreaterThanOrEqual(15);
    expect(freshR.slotLag.max).toBe(0);
    expect(flakyR.slotLag.avg).toBe(20);
    const md = toMarkdown(report);
    expect(md).toContain("| fresh | getBalance |");
    expect(md).toContain("| flaky | 20 | 20 | 20 | 0 |");
  });

  it("redacts API keys and builds sensible params", () => {
    expect(redact("https://mainnet.helius-rpc.com/?api-key=secret123")).toBe("https://mainnet.helius-rpc.com/?api-key=REDACTED");
    expect(parseCalls(["getSlot", "getBalance:Me111111111111111111111111111111111111111"], "X")).toEqual([
      { method: "getSlot", params: [{ commitment: "confirmed" }] },
      { method: "getBalance", params: ["Me111111111111111111111111111111111111111", { commitment: "confirmed" }] },
    ]);
    expect(percentile([5, 1, 9, 3], 0.5)).toBe(5);
    expect(percentile([], 0.95)).toBe(0);
  });
});
