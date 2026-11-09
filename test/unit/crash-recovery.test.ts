import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger, LedgerError } from "../../src/ledger/ledger.js";

/**
 * Crash and restart behaviour against a file-backed ledger. A "crash" closes
 * the database between steps without running the rest of the request, then a
 * fresh Ledger opens the same file, as a restarted process would.
 */
const W = "Crash111111111111111111111111111111111111111";
const NET = "solana:test";
const ASSET = "Mint111111111111111111111111111111111111111";

describe("crash recovery (file-backed ledger)", () => {
  let dir: string;
  let path: string;
  let now: number;
  const open: Ledger[] = [];

  const openLedger = (p = path) => {
    const l = new Ledger({ path: p, defaultDailyCap: null, now: () => now });
    open.push(l);
    return l;
  };
  /** Simulates the process dying: the connection goes away with nothing else run. */
  const crash = (l: Ledger) => {
    l.close();
    open.splice(open.indexOf(l), 1);
  };
  const fund = (l: Ledger, amount: number, n = 1) => {
    l.beginTopup({ payloadHash: `hash-${n}`, network: NET, asset: ASSET, amount });
    return l.completeTopup({ payloadHash: `hash-${n}`, wallet: W, txSignature: `sig-${n}`, amount, network: NET, asset: ASSET });
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "odometer-crash-"));
    path = join(dir, "ledger.db");
    now = Date.parse("2026-11-09T12:00:00Z");
  });
  afterEach(() => {
    for (const l of open.splice(0)) l.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("releases a request interrupted mid-flight and lets the same key run again, uncharged", () => {
    let l = openLedger();
    fund(l, 1_000_000);
    expect(l.idempotencyBegin(W, "key-1", "h")).toEqual({ state: "new" });
    const res = l.reserve({ wallet: W, amount: 100, tier: "economy", methods: ["getSlot"], requestId: "req-1" });
    expect(res.ok).toBe(true);
    crash(l); // died after reserving, before the upstream answered

    l = openLedger();
    expect(l.getAccount(W)!.reserved).toBe(100);
    expect(l.getReceipt(W, { requestId: "req-1" })!.state).toBe("in_flight");
    expect(l.recoverAfterRestart()).toEqual({ releasedReservations: 1, abortedReceipts: 1 });

    const acct = l.getAccount(W)!;
    expect(acct).toMatchObject({ balance: 1_000_000, reserved: 0, available: 1_000_000 });
    expect(l.getReceipt(W, { requestId: "req-1" })).toMatchObject({ state: "not_charged", chargedMicros: 0 });
    expect(l.getReceipt(W, { idempotencyKey: "key-1" })).toMatchObject({ state: "not_charged" });
    // The client retries with the same key: it runs again instead of hanging as in_flight.
    expect(l.idempotencyBegin(W, "key-1", "h")).toEqual({ state: "new" });
    expect(l.reconcile().arithmeticOk).toBe(true);
  });

  it("keeps a charge and its replay receipt together across a restart", () => {
    let l = openLedger();
    fund(l, 1_000_000);
    l.idempotencyBegin(W, "key-2", "h");
    const res = l.reserve({ wallet: W, amount: 100, tier: "economy", methods: ["getSlot"], requestId: "req-2" });
    if (!res.ok) throw new Error("reserve failed");
    l.finalize(res.reservationId, 100, 1, { wallet: W, key: "key-2", requestId: "req-2", status: 200, headers: { "x-a": "1" }, body: '{"result":1}' });
    crash(l); // died right after the debit committed, before the response was written

    l = openLedger();
    expect(l.recoverAfterRestart()).toEqual({ releasedReservations: 0, abortedReceipts: 0 });
    expect(l.available(W)).toBe(999_900);
    // A retry replays the stored response instead of charging again.
    expect(l.idempotencyBegin(W, "key-2", "h")).toEqual({ state: "replay", status: 200, headers: { "x-a": "1" }, body: '{"result":1}' });
    expect(l.getReceipt(W, { idempotencyKey: "key-2" })).toMatchObject({ requestId: "req-2", state: "charged", chargedMicros: 100, httpStatus: 200 });
    expect(l.available(W)).toBe(999_900);
  });

  it("rolls the debit back when the receipt cannot be written", () => {
    let l = openLedger();
    fund(l, 1_000_000);
    l.idempotencyBegin(W, "key-3", "h");
    const res = l.reserve({ wallet: W, amount: 100, tier: "economy", methods: ["getSlot"], requestId: "req-3" });
    if (!res.ok) throw new Error("reserve failed");
    // Inject a failure inside finalize's transaction, at the receipt write.
    l.db.exec("CREATE TRIGGER inject_receipt_failure BEFORE UPDATE ON idempotency BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END;");
    expect(() =>
      l.finalize(res.reservationId, 100, 1, { wallet: W, key: "key-3", requestId: "req-3", status: 200, headers: {}, body: "{}" }),
    ).toThrow(/injected receipt failure/);
    // Neither half happened: no debit, reservation still open, key still in flight.
    expect(l.getAccount(W)).toMatchObject({ balance: 1_000_000, reserved: 100 });
    expect(l.getReceipt(W, { requestId: "req-3" })!.state).toBe("in_flight");
    expect(l.reconcile().arithmeticOk).toBe(true);
    l.db.exec("DROP TRIGGER inject_receipt_failure");
    crash(l);

    l = openLedger();
    l.recoverAfterRestart();
    expect(l.getAccount(W)).toMatchObject({ balance: 1_000_000, reserved: 0 });
    expect(l.idempotencyBegin(W, "key-3", "h")).toEqual({ state: "new" });
  });

  it("never stores a charged request as aborted, so it cannot be charged twice", () => {
    const l = openLedger();
    fund(l, 1_000_000);
    l.idempotencyBegin(W, "key-4", "h");
    const res = l.reserve({ wallet: W, amount: 100, tier: "economy", methods: ["getSlot"], requestId: "req-4" });
    if (!res.ok) throw new Error("reserve failed");
    // The handler threw after the upstream answered and the call was billable.
    l.finalize(res.reservationId, 100, 1, { wallet: W, key: "key-4", requestId: "req-4", abort: true });
    const retry = l.idempotencyBegin(W, "key-4", "h");
    expect(retry).toMatchObject({ state: "replay", status: 500 });
    expect(l.available(W)).toBe(999_900);
  });

  it("surfaces a settlement that was in progress when the process died", () => {
    let l = openLedger();
    expect(l.beginTopup({ payloadHash: "hash-settling", network: NET, asset: ASSET, amount: 5_000_000 }).status).toBe("new");
    crash(l); // died while the facilitator was settling

    l = openLedger();
    l.recoverAfterRestart();
    expect(l.reconcile()).toMatchObject({ arithmeticOk: true, ok: true }); // too fresh to call stuck
    now += 11 * 60_000;
    const report = l.reconcile();
    expect(report).toMatchObject({ arithmeticOk: true, ok: false, unresolvedTopups: { count: 1, amountMicros: 5_000_000 } });
    expect(report.warnings.join(" ")).toMatch(/unknown outcome/);
    expect(l.unresolvedTopups().map((t) => t.payload_hash)).toEqual(["hash-settling"]);
    // The same payment is not re-settled automatically.
    expect(l.beginTopup({ payloadHash: "hash-settling", network: NET, asset: ASSET, amount: 5_000_000 }).status).not.toBe("new");
  });

  it("keeps a pending refund owed across a restart", () => {
    let l = openLedger();
    fund(l, 2_000_000);
    const refund = l.requestRefund(W, 500_000, "Dest11111111111111111111111111111111111111");
    crash(l);

    l = openLedger();
    l.recoverAfterRestart();
    expect(l.getRefund(refund.id)!.status).toBe("requested");
    expect(l.available(W)).toBe(1_500_000);
    const report = l.reconcile();
    expect(report).toMatchObject({ arithmeticOk: true, pendingRefunds: { count: 1, amountMicros: 500_000 }, liabilitiesMicros: 2_000_000 });
    l.resolveRefund(refund.id, "paid", { txSignature: "refund-sig" });
    expect(l.reconcile()).toMatchObject({ pendingRefunds: { count: 0 }, liabilitiesMicros: 1_500_000 });
  });

  it("restores a consistent snapshot from backup()", () => {
    const l = openLedger();
    fund(l, 3_000_000);
    l.requestRefund(W, 1_000_000, "Dest11111111111111111111111111111111111111");
    const open1 = l.reserve({ wallet: W, amount: 250, tier: "economy", methods: ["getSlot"], requestId: "req-open" });
    expect(open1.ok).toBe(true);
    const snapshot = join(dir, "backup.db");
    l.backup(snapshot);
    fund(l, 7_000_000, 2); // after the snapshot: not in it

    const restored = openLedger(snapshot);
    // A reservation open at backup time can never finish: recovery releases it.
    expect(restored.recoverAfterRestart().releasedReservations).toBe(1);
    expect(restored.getAccount(W)).toMatchObject({ balance: 2_000_000, reserved: 0 });
    expect(restored.reconcile()).toMatchObject({ arithmeticOk: true, liabilitiesMicros: 3_000_000 });
    expect(restored.listTopups().length).toBe(1);
    expect(l.available(W)).toBe(9_000_000 - 250);
  });

  it("allows one writer per database and hands over only after a stale heartbeat", () => {
    const a = openLedger();
    const b = openLedger();
    a.acquireWriterLock("proc-a");
    a.acquireWriterLock("proc-a"); // re-entrant for the same owner
    expect(() => b.acquireWriterLock("proc-b")).toThrow(LedgerError);
    try {
      b.acquireWriterLock("proc-b");
    } catch (err) {
      expect((err as LedgerError).code).toBe("ledger_locked");
    }
    now += 20_000;
    expect(a.heartbeatWriterLock("proc-a")).toBe(true);
    now += 20_000; // 20s since a's last heartbeat: still live
    expect(() => b.acquireWriterLock("proc-b")).toThrow(/Another gateway process/);
    now += 15_000; // 35s: a is presumed dead
    b.acquireWriterLock("proc-b");
    expect(a.heartbeatWriterLock("proc-a")).toBe(false); // a learns it lost the lock
    a.releaseWriterLock("proc-a"); // must not release b's lock
    expect(() => a.acquireWriterLock("proc-a")).toThrow(/proc-b/);
    b.releaseWriterLock("proc-b");
    a.acquireWriterLock("proc-a");
  });
});
