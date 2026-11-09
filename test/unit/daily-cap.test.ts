import { describe, expect, it } from "vitest";
import { Ledger, LedgerError } from "../../src/ledger/ledger.js";

/**
 * Review finding 1 (2026-11-09): a wallet cap of zero erased the operator
 * ceiling. Semantics now: null = no cap, 0 = no spending, and a wallet's own
 * cap can only tighten the operator ceiling.
 */
const W = "CapWallet111111111111111111111111111111111";

function ledgerWith(operatorCap: number | null) {
  const ledger = new Ledger({ path: ":memory:", defaultDailyCap: operatorCap });
  ledger.adjust(W, 10_000_000, "test funding");
  return ledger;
}
const reserve = (l: Ledger, amount: number, id = String(Math.random())) =>
  l.reserve({ wallet: W, amount, tier: "fast", methods: ["getSlot"], requestId: id });

describe("daily caps", () => {
  it("a wallet cap of zero stops spending under an operator ceiling (the reviewed bypass)", () => {
    const l = ledgerWith(1_000_000);
    expect(reserve(l, 2_000_000).ok).toBe(false);
    l.setDailyCap(W, 0);
    expect(reserve(l, 2_000_000)).toMatchObject({ ok: false, reason: "daily_cap_exceeded", cap: 0 });
    expect(reserve(l, 1)).toMatchObject({ ok: false, reason: "daily_cap_exceeded", cap: 0 });
    expect(l.effectiveDailyCap(l.getAccount(W))).toBe(0);
  });

  it("a wallet cap of zero stops spending even with no operator ceiling", () => {
    const l = ledgerWith(null);
    expect(reserve(l, 5_000_000).ok).toBe(true);
    l.setDailyCap(W, 0);
    expect(reserve(l, 1).ok).toBe(false);
  });

  it("removing the wallet cap restores the operator ceiling, never unlimited", () => {
    const l = ledgerWith(1_000_000);
    l.setDailyCap(W, 0);
    l.setDailyCap(W, null);
    expect(l.effectiveDailyCap(l.getAccount(W))).toBe(1_000_000);
    expect(reserve(l, 1_000_001).ok).toBe(false);
    expect(reserve(l, 1_000_000).ok).toBe(true);
  });

  it("uses the tighter of wallet and operator caps", () => {
    const l = ledgerWith(1_000_000);
    l.setDailyCap(W, 5_000_000);
    expect(l.effectiveDailyCap(l.getAccount(W))).toBe(1_000_000);
    l.setDailyCap(W, 300_000);
    expect(l.effectiveDailyCap(l.getAccount(W))).toBe(300_000);
  });

  it("is unlimited only when neither the operator nor the wallet set a cap", () => {
    const l = ledgerWith(null);
    expect(l.effectiveDailyCap(l.getAccount(W))).toBeNull();
    expect(reserve(l, 9_000_000).ok).toBe(true);
  });

  it("counts pending reservations against the cap", () => {
    const l = ledgerWith(1_000_000);
    expect(reserve(l, 600_000, "a").ok).toBe(true);
    expect(reserve(l, 600_000, "b")).toMatchObject({ ok: false, reason: "daily_cap_exceeded" });
  });

  it("an operator ceiling of zero means nobody spends", () => {
    const l = ledgerWith(0);
    expect(reserve(l, 1).ok).toBe(false);
  });

  it("rejects invalid caps", () => {
    const l = ledgerWith(null);
    expect(() => l.setDailyCap(W, -1)).toThrow(LedgerError);
    expect(() => l.setDailyCap(W, 1.5)).toThrow(LedgerError);
  });
});
