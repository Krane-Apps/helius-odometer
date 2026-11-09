import { describe, expect, it } from "vitest";
import { Pricing, RPC_ERRORS, type PricingOptions, type Tier } from "../../src/pricing/pricing.js";
import { METHODS } from "../../src/pricing/methods.js";
import { microsToUsd, usdToMicros, microsToAtomic, atomicToMicros } from "../../src/util/money.js";

const all: PricingOptions = {
  enabledTiers: new Set<Tier>(["economy", "standard", "fast"]),
  sendTransactionEnabled: true,
  heliusAvailable: true,
};

describe("money", () => {
  it("converts USD and micros exactly", () => {
    expect(usdToMicros("$0.00001")).toBe(10);
    expect(usdToMicros(1)).toBe(1_000_000);
    expect(microsToUsd(30)).toBe("0.00003");
    expect(microsToUsd(1_500_000)).toBe("1.5");
    expect(microsToAtomic(1_000_000, 9)).toBe(1_000_000_000n);
    expect(atomicToMicros("1000000000", 9)).toBe(1_000_000);
    expect(() => usdToMicros(-1)).toThrow();
  });
});

describe("Pricing", () => {
  const pricing = new Pricing();

  it("prices class A reads by tier with heavy-method weights", () => {
    expect(pricing.priceMethod("economy", "getSlot", all)).toMatchObject({ price: 10, plan: "public-only" });
    expect(pricing.priceMethod("standard", "getSlot", all)).toMatchObject({ price: 30, plan: "public-first" });
    expect(pricing.priceMethod("fast", "getSlot", all)).toMatchObject({ price: 50, plan: "helius" });
    expect(pricing.priceMethod("economy", "getBlock", all).price).toBe(50);
    expect(pricing.priceMethod("economy", "getTransaction", all).price).toBe(20);
  });

  it("bills Helius-backed methods the same on every tier", () => {
    for (const tier of ["economy", "standard", "fast"] as const) {
      expect(pricing.priceMethod(tier, "getAsset", all)).toMatchObject({ price: 200, plan: "helius" });
      expect(pricing.priceMethod(tier, "getProgramAccounts", all)).toMatchObject({ price: 200, plan: "helius" });
      expect(pricing.priceMethod(tier, "getProgramAccountsV2", all)).toMatchObject({ price: 50, plan: "helius" });
      expect(pricing.priceMethod(tier, "simulateTransaction", all)).toMatchObject({ price: 50, plan: "helius" });
    }
  });

  it("allows sendTransaction only on the fast tier and only when enabled", () => {
    expect(pricing.priceMethod("fast", "sendTransaction", all)).toMatchObject({ price: 1000, plan: "helius" });
    expect(pricing.priceMethod("standard", "sendTransaction", all).reject).toBe(RPC_ERRORS.sendNeedsFast);
    expect(
      pricing.priceMethod("fast", "sendTransaction", { ...all, sendTransactionEnabled: false }).reject,
    ).toBe(RPC_ERRORS.sendDisabled);
  });

  it("rejects unknown, blocked, subscription and disabled-tier methods", () => {
    expect(pricing.priceMethod("fast", "eth_call", all).reject).toBe(RPC_ERRORS.methodNotFound);
    expect(pricing.priceMethod("fast", "requestAirdrop", all).reject).toBe(RPC_ERRORS.blocked);
    expect(pricing.priceMethod("fast", "accountSubscribe", all).reject).toBe(RPC_ERRORS.subscription);
    expect(pricing.priceMethod("economy", "getSlot", { ...all, enabledTiers: new Set(["fast"]) }).reject).toBe(
      RPC_ERRORS.tierUnavailable,
    );
  });

  it("quotes batches and excludes rejected items from the total", () => {
    const q = pricing.quote("economy", ["getSlot", "getAsset", "nope", "sendTransaction"], all);
    expect(q.total).toBe(10 + 200);
    expect(q.items.map((i) => Boolean(i.reject))).toEqual([false, false, true, true]);
  });

  it("rejects Helius-only methods when no Helius upstream is configured", () => {
    const q = pricing.quote("economy", ["getSlot", "getAsset"], { ...all, heliusAvailable: false });
    expect(q.items[1]!.reject).toBe(RPC_ERRORS.heliusUnavailable);
    expect(q.total).toBe(10);
  });

  it("applies per-method overrides", () => {
    const custom = new Pricing({ ...pricing.config, overrides: { getSlot: 0.000002 } });
    expect(custom.priceMethod("fast", "getSlot", all).price).toBe(2);
  });

  it("keeps the catalog internally consistent", () => {
    for (const spec of METHODS.values()) {
      if (spec.cls === "B" || spec.cls === "C") expect(spec.credits).toBeGreaterThan(0);
      if (spec.contextResponse || spec.minContextSlot || spec.injectCommitment) {
        expect(spec.configIndex, spec.name).toBeTypeOf("number");
      }
    }
  });
});
