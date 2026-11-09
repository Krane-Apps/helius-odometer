import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Ledger, LedgerError } from "../../src/ledger/ledger.js";

const W = "Wa11et1111111111111111111111111111111111111";
const NET = "solana:test";
const ASSET = "Mint111111111111111111111111111111111111111";

describe("Ledger", () => {
  let now = Date.parse("2026-11-09T12:00:00Z");
  let ledger: Ledger;

  beforeEach(() => {
    now = Date.parse("2026-11-09T12:00:00Z");
    ledger = new Ledger({ path: ":memory:", defaultDailyCap: 10_000_000, now: () => now });
  });
  afterEach(() => ledger.close());

  const topup = (amount: number, hash = "hash-1", sig = "sig-1") => {
    const begin = ledger.beginTopup({ payloadHash: hash, network: NET, asset: ASSET, amount });
    expect(begin.status).toBe("new");
    return ledger.completeTopup({ payloadHash: hash, wallet: W, txSignature: sig, amount, network: NET, asset: ASSET });
  };

  it("credits a top-up exactly once", () => {
    const first = topup(1_000_000);
    expect(first.credited).toBe(true);
    expect(ledger.available(W)).toBe(1_000_000);

    // Replaying the same payload is refused before settlement.
    const replay = ledger.beginTopup({ payloadHash: "hash-1", network: NET, asset: ASSET, amount: 1_000_000 });
    expect(replay.status).toBe("duplicate-settled");

    // A second completion for the same tx signature never credits again.
    const again = ledger.completeTopup({
      payloadHash: "hash-2",
      wallet: W,
      txSignature: "sig-1",
      amount: 1_000_000,
      network: NET,
      asset: ASSET,
    });
    expect(again.credited).toBe(false);
    expect(ledger.available(W)).toBe(1_000_000);
    expect(ledger.reconcile().ok).toBe(true);
  });

  it("flags concurrent duplicate settlements and allows retry after failure", () => {
    ledger.beginTopup({ payloadHash: "h", network: NET, asset: ASSET, amount: 5 });
    expect(ledger.beginTopup({ payloadHash: "h", network: NET, asset: ASSET, amount: 5 }).status).toBe(
      "duplicate-in-flight",
    );
    ledger.failTopup("h", "blockhash expired");
    expect(ledger.beginTopup({ payloadHash: "h", network: NET, asset: ASSET, amount: 5 }).status).toBe("new");
  });

  it("reserves, finalizes a partial charge and releases the remainder", () => {
    topup(1_000);
    const r = ledger.reserve({ wallet: W, amount: 300, tier: "standard", methods: ["getSlot"], requestId: "q1" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(ledger.getAccount(W)!.reserved).toBe(300);
    expect(ledger.available(W)).toBe(700);
    const f = ledger.finalize(r.reservationId, 120, 2);
    expect(f.charged).toBe(120);
    expect(f.balance).toBe(880);
    expect(ledger.getAccount(W)!.reserved).toBe(0);
    // Finalizing twice is a no-op.
    expect(ledger.finalize(r.reservationId, 300).charged).toBe(120);
    expect(ledger.available(W)).toBe(880);
    expect(ledger.spentToday(W)).toBe(120);
    expect(ledger.reconcile().ok).toBe(true);
  });

  it("caps a finalize at the reserved amount", () => {
    topup(1_000);
    const r = ledger.reserve({ wallet: W, amount: 100, tier: "fast", methods: ["getSlot"], requestId: "q" });
    if (!r.ok) throw new Error("expected reservation");
    expect(ledger.finalize(r.reservationId, 5_000).charged).toBe(100);
  });

  it("releases a reservation without charging", () => {
    topup(1_000);
    const r = ledger.reserve({ wallet: W, amount: 400, tier: "fast", methods: ["getSlot"], requestId: "q" });
    if (!r.ok) throw new Error("expected reservation");
    ledger.release(r.reservationId);
    ledger.release(r.reservationId);
    expect(ledger.available(W)).toBe(1_000);
    expect(ledger.getAccount(W)!.totalSpent).toBe(0);
  });

  it("refuses reservations beyond the available balance", () => {
    topup(100);
    const r = ledger.reserve({ wallet: W, amount: 101, tier: "fast", methods: ["getSlot"], requestId: "q" });
    expect(r).toMatchObject({ ok: false, reason: "insufficient_balance", available: 100 });
    const unknown = ledger.reserve({ wallet: "nobody", amount: 1, tier: "fast", methods: ["getSlot"], requestId: "q" });
    expect(unknown).toMatchObject({ ok: false, reason: "insufficient_balance", available: 0 });
  });

  it("enforces the daily spend cap including open reservations", () => {
    topup(20_000_000);
    ledger.setDailyCap(W, 1_000);
    const a = ledger.reserve({ wallet: W, amount: 600, tier: "fast", methods: ["x"], requestId: "a" });
    expect(a.ok).toBe(true);
    const b = ledger.reserve({ wallet: W, amount: 600, tier: "fast", methods: ["x"], requestId: "b" });
    expect(b).toMatchObject({ ok: false, reason: "daily_cap_exceeded", cap: 1_000 });
    if (a.ok) ledger.finalize(a.reservationId, 600);
    // Next UTC day resets the spend counter.
    now += 86_400_000;
    expect(ledger.reserve({ wallet: W, amount: 600, tier: "fast", methods: ["x"], requestId: "c" }).ok).toBe(true);
  });

  it("never lets a wallet raise its cap above the gateway default", () => {
    topup(50_000_000);
    ledger.setDailyCap(W, 999_000_000);
    expect(ledger.effectiveDailyCap(ledger.getAccount(W))).toBe(10_000_000);
  });

  it("handles refunds: request debits, rejection re-credits", () => {
    topup(5_000);
    const refund = ledger.requestRefund(W, 2_000, "Dest111111111111111111111111111111111111111");
    expect(refund.status).toBe("requested");
    expect(ledger.available(W)).toBe(3_000);
    const rejected = ledger.resolveRefund(refund.id, "rejected", { note: "test" });
    expect(rejected.status).toBe("rejected");
    expect(ledger.available(W)).toBe(5_000);
    const all = ledger.requestRefund(W, undefined, "Dest111111111111111111111111111111111111111");
    expect(all.amount).toBe(5_000);
    expect(ledger.resolveRefund(all.id, "paid", { txSignature: "paid-sig" }).txSignature).toBe("paid-sig");
    expect(() => ledger.resolveRefund(all.id, "paid")).toThrow(LedgerError);
    expect(() => ledger.requestRefund(W, 1, "x")).toThrow(LedgerError);
    expect(ledger.reconcile().ok).toBe(true);
  });

  it("does not refund reserved funds", () => {
    topup(1_000);
    const r = ledger.reserve({ wallet: W, amount: 900, tier: "fast", methods: ["x"], requestId: "q" });
    expect(r.ok).toBe(true);
    expect(() => ledger.requestRefund(W, 500, "dest")).toThrow(/exceeds/);
  });

  it("journals manual adjustments", () => {
    const acct = ledger.adjust(W, 250, "goodwill credit");
    expect(acct.balance).toBe(250);
    expect(() => ledger.adjust(W, -1_000, "too much")).toThrow(LedgerError);
    expect(ledger.journal(W)[0]).toMatchObject({ kind: "adjustment", amount: 250 });
    expect(ledger.reconcile().ok).toBe(true);
  });

  it("reconciliation releases stale reservations and detects tampering", () => {
    topup(1_000);
    const r = ledger.reserve({ wallet: W, amount: 100, tier: "fast", methods: ["x"], requestId: "q" });
    expect(r.ok).toBe(true);
    ledger.beginTopup({ payloadHash: "stuck", network: NET, asset: ASSET, amount: 1 });
    now += 15 * 60_000;
    const report = ledger.reconcile();
    expect(report.releasedStaleReservations).toBe(1);
    expect(report.topupsNeedingReview).toBe(1);
    expect(report.arithmeticOk).toBe(true);
    expect(report.ok).toBe(false);
    expect(report.unresolvedTopups).toEqual({ count: 1, amountMicros: 1 });
    ledger.db.prepare("UPDATE accounts SET balance = balance + 1 WHERE wallet = ?").run(W);
    const bad = ledger.reconcile();
    expect(bad.ok).toBe(false);
    expect(bad.balanceMismatches[0]).toMatchObject({ wallet: W, balance: 1_001, journalSum: 1_000 });
  });

  it("supports idempotency keys", () => {
    expect(ledger.idempotencyBegin(W, "k1", "h1")).toEqual({ state: "new" });
    expect(ledger.idempotencyBegin(W, "k1", "h1")).toEqual({ state: "in_flight" });
    expect(ledger.idempotencyBegin(W, "k1", "other")).toEqual({ state: "mismatch" });
    ledger.idempotencyComplete(W, "k1", 200, { "x-a": "1" }, '{"ok":true}');
    expect(ledger.idempotencyBegin(W, "k1", "h1")).toEqual({
      state: "replay",
      status: 200,
      headers: { "x-a": "1" },
      body: '{"ok":true}',
    });
    expect(ledger.idempotencyBegin(W, "k2", "h")).toEqual({ state: "new" });
    ledger.idempotencyAbort(W, "k2");
    expect(ledger.idempotencyBegin(W, "k2", "h")).toEqual({ state: "new" });
  });

  it("uses each SIWx nonce once", () => {
    expect(ledger.useNonce("n1", now + 1000)).toBe(true);
    expect(ledger.useNonce("n1", now + 1000)).toBe(false);
    now += 5000;
    expect(ledger.pruneNonces()).toBe(1);
  });

  it("reports funnel stats", () => {
    topup(1_000);
    ledger.recordEvent("challenge", null, "ip-a");
    ledger.recordEvent("challenge", null, "ip-b");
    ledger.recordEvent("topup", W);
    const stats = ledger.stats() as { totals: Record<string, number>; events: Array<{ kind: string; count: number }> };
    expect(stats.totals.fundedWallets).toBe(1);
    expect(stats.events.find((e) => e.kind === "challenge")?.count).toBe(2);
  });
});
