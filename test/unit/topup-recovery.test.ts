import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Ledger, LedgerError } from "../../src/ledger/ledger.js";
import { classifySettleFailure } from "../../src/payments/settle-outcome.js";

/**
 * Review finding 4 (2026-11-09): recovering a stuck top-up with a generic
 * adjustment left the original receipt eligible for a second credit. Recovery
 * now resolves the original receipt itself.
 */
const W = "Recover111111111111111111111111111111111111";
const base = { network: "solana:test", asset: "Mint111111111111111111111111111111111111111" };

describe("top-up recovery", () => {
  let ledger: Ledger;
  beforeEach(() => {
    ledger = new Ledger({ path: ":memory:", defaultDailyCap: null });
  });
  afterEach(() => ledger.close());

  const stuck = (hash = "h", sig = "sig-1") => {
    const begin = ledger.beginTopup({ payloadHash: hash, amount: 1_000_000, ...base });
    ledger.markTopupNeedsReview(hash, "settlement outcome unknown", { wallet: W, txSignature: sig });
    return begin.id;
  };

  it("an operator credit on the original receipt can never be followed by a second credit", () => {
    const id = stuck();
    const res = ledger.resolveTopup({ topupId: id, action: "credit", wallet: W, txSignature: "sig-1", note: "verified on-chain" });
    expect(res.credited).toBe(true);
    expect(ledger.available(W)).toBe(1_000_000);
    // The delayed facilitator completion of the same payment arrives later.
    const late = ledger.completeTopup({ payloadHash: "h", wallet: W, txSignature: "sig-1", amount: 1_000_000, ...base });
    expect(late.credited).toBe(false);
    expect(ledger.available(W)).toBe(1_000_000);
    // A replay of the same payload is refused before settlement.
    expect(ledger.beginTopup({ payloadHash: "h", amount: 1_000_000, ...base }).status).toBe("duplicate-settled");
    expect(() => ledger.resolveTopup({ topupId: id, action: "credit", wallet: W, txSignature: "sig-1", note: "again" })).toThrow(LedgerError);
    expect(ledger.reconcile().ok).toBe(true);
  });

  it("takes the amount from the receipt, never from the operator", () => {
    const id = stuck();
    ledger.resolveTopup({ topupId: id, action: "credit", wallet: W, txSignature: "sig-1", note: "verified" });
    expect(ledger.getTopup(id)).toMatchObject({ status: "settled", amount: 1_000_000, resolution: "operator_credit" });
  });

  it("refuses to credit a signature already credited to another top-up", () => {
    ledger.beginTopup({ payloadHash: "a", amount: 1_000_000, ...base });
    ledger.completeTopup({ payloadHash: "a", wallet: W, txSignature: "sig-x", amount: 1_000_000, ...base });
    const id = stuck("b", "sig-y");
    expect(() => ledger.resolveTopup({ topupId: id, action: "credit", wallet: W, txSignature: "sig-x", note: "wrong" })).toThrow(
      /already credited/,
    );
  });

  it("freezes a payment under review against automatic retries", () => {
    stuck();
    expect(ledger.beginTopup({ payloadHash: "h", amount: 1_000_000, ...base }).status).toBe("under-review");
  });

  it("sends a settlement that arrives after an operator rejection back to review", () => {
    const id = stuck();
    ledger.resolveTopup({ topupId: id, action: "reject", note: "no transfer found" });
    const late = ledger.completeTopup({ payloadHash: "h", wallet: W, txSignature: "sig-1", amount: 1_000_000, ...base });
    expect(late.credited).toBe(false);
    expect(ledger.getTopup(id)).toMatchObject({ status: "needs_review", error: "late settlement after operator rejection" });
    expect(ledger.available(W)).toBe(0);
  });

  it("still lets a definitely failed payment be retried", () => {
    ledger.beginTopup({ payloadHash: "f", amount: 1_000_000, ...base });
    ledger.failTopup("f", "transaction_failed");
    expect(ledger.beginTopup({ payloadHash: "f", amount: 1_000_000, ...base }).status).toBe("new");
  });

  it("requires a note and refuses unknown or settling top-ups", () => {
    const id = stuck();
    expect(() => ledger.resolveTopup({ topupId: id, action: "reject", note: " " })).toThrow(/note/);
    expect(() => ledger.resolveTopup({ topupId: "nope", action: "reject", note: "x" })).toThrow(/unknown/);
    const settling = ledger.beginTopup({ payloadHash: "s", amount: 1, ...base }).id;
    expect(() => ledger.resolveTopup({ topupId: settling, action: "credit", wallet: W, txSignature: "z", note: "x" })).toThrow(/still settling/);
  });
});

describe("classifySettleFailure", () => {
  const settleError = (errorReason: string, transaction = "") => Object.assign(new Error(errorReason), { name: "SettleError", errorReason, transaction });

  it("treats proven failures as retryable", () => {
    expect(classifySettleFailure(settleError("transaction_failed"))).toMatchObject({ kind: "failed" });
    expect(classifySettleFailure(settleError("invalid_exact_svm_payload_transaction"))).toMatchObject({ kind: "failed" });
    expect(classifySettleFailure(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }))).toMatchObject({ kind: "failed" });
  });

  it("treats anything that may have moved funds as ambiguous", () => {
    expect(classifySettleFailure(settleError("settlement_pending", "5ig"))).toEqual({
      kind: "ambiguous",
      reason: "broadcast but not confirmed: settlement_pending",
      txSignature: "5ig",
      payer: undefined,
    });
    expect(classifySettleFailure(settleError("unexpected_settle_error"))).toMatchObject({ kind: "ambiguous" });
    expect(classifySettleFailure(Object.assign(new Error("timed out"), { name: "FacilitatorTimeoutError" }))).toMatchObject({ kind: "ambiguous" });
    expect(classifySettleFailure(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }))).toMatchObject({ kind: "ambiguous" });
  });
});
