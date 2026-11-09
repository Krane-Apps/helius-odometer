import { openDb, transaction, type Db } from "./db.js";
import { newId } from "../util/ids.js";
import type { Micros } from "../util/money.js";

export interface Account {
  wallet: string;
  balance: Micros;
  reserved: Micros;
  available: Micros;
  totalToppedUp: Micros;
  totalSpent: Micros;
  totalRefunded: Micros;
  dailyCap: Micros | null;
  sessionEpoch: number;
  createdAt: number;
  updatedAt: number;
}

export type TopupBegin =
  | { status: "new"; id: string }
  | { status: "duplicate-settled"; id: string; txSignature: string | null }
  | { status: "duplicate-in-flight"; id: string };

export type ReserveResult =
  | { ok: true; reservationId: string; available: Micros }
  | { ok: false; reason: "insufficient_balance"; available: Micros }
  | { ok: false; reason: "daily_cap_exceeded"; available: Micros; cap: Micros; spentToday: Micros };

export type IdempotencyBegin =
  | { state: "new" }
  | { state: "replay"; status: number; headers: Record<string, string>; body: string }
  | { state: "in_flight" }
  | { state: "mismatch" };

export interface Refund {
  id: string;
  wallet: string;
  amount: Micros;
  destination: string;
  status: "requested" | "paid" | "rejected";
  txSignature: string | null;
  note: string | null;
  createdAt: number;
  resolvedAt: number | null;
}

export interface ReconcileReport {
  checkedAccounts: number;
  balanceMismatches: Array<{ wallet: string; balance: Micros; journalSum: Micros }>;
  reservedMismatches: Array<{ wallet: string; reserved: Micros; openReservations: Micros }>;
  releasedStaleReservations: number;
  topupsNeedingReview: number;
  ok: boolean;
}

export interface LedgerOptions {
  path: string;
  /** Default per-wallet daily spend cap in micros; 0 disables the cap. */
  defaultDailyCap: Micros;
  now?: () => number;
}

interface AccountRow {
  wallet: string;
  balance: number;
  reserved: number;
  total_topped_up: number;
  total_spent: number;
  total_refunded: number;
  daily_cap: number | null;
  session_epoch: number;
  created_at: number;
  updated_at: number;
}

const DAY_MS = 86_400_000;

/**
 * The balance ledger. Every balance change is written to an append-only
 * journal with a unique (kind, ref) receipt, so replays can never double-credit
 * or double-debit, and `reconcile()` can prove balance == sum(journal).
 *
 * Spending follows reserve -> finalize/release: a call's price is reserved
 * before it is routed, debited only when a response is handed back, and
 * released when the call fails, so a charged-but-unserved call cannot persist.
 */
export class Ledger {
  readonly db: Db;
  private readonly now: () => number;
  private readonly defaultDailyCap: Micros;

  constructor(opts: LedgerOptions) {
    this.db = openDb(opts.path);
    this.now = opts.now ?? Date.now;
    this.defaultDailyCap = opts.defaultDailyCap;
  }

  close(): void {
    this.db.close();
  }

  private day(ts = this.now()): string {
    return new Date(ts).toISOString().slice(0, 10);
  }

  // ---------------------------------------------------------------- accounts

  getAccount(wallet: string): Account | undefined {
    const row = this.db.prepare("SELECT * FROM accounts WHERE wallet = ?").get(wallet) as AccountRow | undefined;
    return row ? toAccount(row) : undefined;
  }

  available(wallet: string): Micros {
    return this.getAccount(wallet)?.available ?? 0;
  }

  spentToday(wallet: string): Micros {
    const row = this.db
      .prepare("SELECT spent FROM daily_usage WHERE wallet = ? AND day = ?")
      .get(wallet, this.day()) as { spent: number } | undefined;
    return row?.spent ?? 0;
  }

  effectiveDailyCap(account: Pick<Account, "dailyCap"> | undefined): Micros {
    const own = account?.dailyCap;
    if (own === null || own === undefined) return this.defaultDailyCap;
    if (this.defaultDailyCap > 0) return Math.min(own, this.defaultDailyCap);
    return own;
  }

  private ensureAccount(wallet: string): void {
    const now = this.now();
    this.db
      .prepare("INSERT OR IGNORE INTO accounts (wallet, created_at, updated_at) VALUES (?, ?, ?)")
      .run(wallet, now, now);
  }

  /** Sets a wallet's own daily cap (null resets to the gateway default). */
  setDailyCap(wallet: string, cap: Micros | null): Account {
    return transaction(this.db, () => {
      this.ensureAccount(wallet);
      this.db.prepare("UPDATE accounts SET daily_cap = ?, updated_at = ? WHERE wallet = ?").run(cap, this.now(), wallet);
      return this.getAccount(wallet)!;
    });
  }

  /** Invalidates every session token issued to this wallet so far. */
  bumpSessionEpoch(wallet: string): number {
    return transaction(this.db, () => {
      this.ensureAccount(wallet);
      this.db
        .prepare("UPDATE accounts SET session_epoch = session_epoch + 1, updated_at = ? WHERE wallet = ?")
        .run(this.now(), wallet);
      return this.getAccount(wallet)!.sessionEpoch;
    });
  }

  // ------------------------------------------------------------------ topups

  /**
   * Records a settlement attempt before the facilitator is called, keyed by
   * the hash of the signed payment payload. A payload that already settled is
   * refused so a replayed PAYMENT-SIGNATURE can never credit twice.
   */
  beginTopup(args: { payloadHash: string; network: string; asset: string; amount: Micros }): TopupBegin {
    return transaction(this.db, () => {
      const row = this.db
        .prepare("SELECT id, status, tx_signature FROM topups WHERE payload_hash = ?")
        .get(args.payloadHash) as { id: string; status: string; tx_signature: string | null } | undefined;
      if (row?.status === "settled") return { status: "duplicate-settled", id: row.id, txSignature: row.tx_signature };
      if (row?.status === "settling") return { status: "duplicate-in-flight", id: row.id };
      if (row) {
        this.db.prepare("UPDATE topups SET status = 'settling', error = NULL WHERE id = ?").run(row.id);
        return { status: "new", id: row.id };
      }
      const id = newId("top");
      this.db
        .prepare(
          `INSERT INTO topups (id, amount, network, asset, payload_hash, status, created_at)
           VALUES (?, ?, ?, ?, ?, 'settling', ?)`,
        )
        .run(id, args.amount, args.network, args.asset, args.payloadHash, this.now());
      return { status: "new", id };
    });
  }

  /**
   * Credits a settled top-up exactly once. Idempotent on both the payload hash
   * and the on-chain transaction signature.
   */
  completeTopup(args: {
    payloadHash: string;
    wallet: string;
    txSignature: string;
    amount: Micros;
    network: string;
    asset: string;
  }): { credited: boolean; topupId: string; balance: Micros } {
    if (!(args.amount > 0)) throw new Error("top-up amount must be positive");
    return transaction(this.db, () => {
      const bySig = this.db
        .prepare("SELECT id, payload_hash, status FROM topups WHERE tx_signature = ?")
        .get(args.txSignature) as { id: string; payload_hash: string; status: string } | undefined;
      if (bySig && bySig.status === "settled") {
        return { credited: false, topupId: bySig.id, balance: this.getAccount(args.wallet)?.balance ?? 0 };
      }
      let row = this.db.prepare("SELECT id, status FROM topups WHERE payload_hash = ?").get(args.payloadHash) as
        | { id: string; status: string }
        | undefined;
      if (row?.status === "settled") {
        return { credited: false, topupId: row.id, balance: this.getAccount(args.wallet)?.balance ?? 0 };
      }
      const now = this.now();
      if (!row) {
        const id = newId("top");
        this.db
          .prepare(
            `INSERT INTO topups (id, amount, network, asset, payload_hash, status, created_at)
             VALUES (?, ?, ?, ?, ?, 'settling', ?)`,
          )
          .run(id, args.amount, args.network, args.asset, args.payloadHash, now);
        row = { id, status: "settling" };
      }
      this.db
        .prepare(
          `UPDATE topups SET status = 'settled', wallet = ?, tx_signature = ?, amount = ?, settled_at = ?, error = NULL
           WHERE id = ?`,
        )
        .run(args.wallet, args.txSignature, args.amount, now, row.id);
      this.ensureAccount(args.wallet);
      this.db
        .prepare(
          `UPDATE accounts SET balance = balance + ?, total_topped_up = total_topped_up + ?, updated_at = ?
           WHERE wallet = ?`,
        )
        .run(args.amount, args.amount, now, args.wallet);
      this.db
        .prepare("INSERT INTO journal (wallet, kind, amount, ref, note, created_at) VALUES (?, 'topup', ?, ?, ?, ?)")
        .run(args.wallet, args.amount, row.id, args.txSignature, now);
      return { credited: true, topupId: row.id, balance: this.getAccount(args.wallet)!.balance };
    });
  }

  failTopup(payloadHash: string, error: string): void {
    this.db
      .prepare("UPDATE topups SET status = 'failed', error = ? WHERE payload_hash = ? AND status = 'settling'")
      .run(error.slice(0, 500), payloadHash);
  }

  markTopupNeedsReview(payloadHash: string, error: string, details?: { wallet?: string; txSignature?: string }): void {
    this.db
      .prepare(
        `UPDATE topups SET status = 'needs_review', error = ?, wallet = COALESCE(?, wallet),
         tx_signature = COALESCE(?, tx_signature) WHERE payload_hash = ? AND status != 'settled'`,
      )
      .run(error.slice(0, 500), details?.wallet ?? null, details?.txSignature ?? null, payloadHash);
  }

  listTopups(filter: { status?: string; wallet?: string; limit?: number } = {}): Array<Record<string, unknown>> {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (filter.status) {
      where.push("status = ?");
      params.push(filter.status);
    }
    if (filter.wallet) {
      where.push("wallet = ?");
      params.push(filter.wallet);
    }
    const sql = `SELECT * FROM topups ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT ?`;
    params.push(Math.min(filter.limit ?? 100, 1000));
    return this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  }

  // ---------------------------------------------------------------- spending

  reserve(args: { wallet: string; amount: Micros; tier: string; methods: string[]; requestId: string }): ReserveResult {
    if (!(args.amount > 0)) throw new Error("reservation amount must be positive");
    return transaction(this.db, () => {
      const account = this.getAccount(args.wallet);
      const available = account?.available ?? 0;
      if (!account || available < args.amount) return { ok: false, reason: "insufficient_balance", available };
      const cap = this.effectiveDailyCap(account);
      const spentToday = this.spentToday(args.wallet);
      if (cap > 0 && spentToday + account.reserved + args.amount > cap) {
        return { ok: false, reason: "daily_cap_exceeded", available, cap, spentToday };
      }
      const id = newId("res");
      const now = this.now();
      this.db
        .prepare("UPDATE accounts SET reserved = reserved + ?, updated_at = ? WHERE wallet = ?")
        .run(args.amount, now, args.wallet);
      this.db
        .prepare(
          `INSERT INTO reservations (id, wallet, amount, tier, methods, request_id, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?)`,
        )
        .run(id, args.wallet, args.amount, args.tier, args.methods.join(",").slice(0, 2000), args.requestId, now);
      return { ok: true, reservationId: id, available: available - args.amount };
    });
  }

  /**
   * Debits `charged` (capped at the reserved amount) and releases the rest.
   * Safe to call twice: a resolved reservation is left untouched.
   */
  finalize(reservationId: string, charged: Micros, calls = 1): { charged: Micros; balance: Micros; available: Micros } {
    return transaction(this.db, () => {
      const res = this.db
        .prepare("SELECT wallet, amount, status, charged FROM reservations WHERE id = ?")
        .get(reservationId) as { wallet: string; amount: number; status: string; charged: number } | undefined;
      if (!res) throw new Error(`unknown reservation ${reservationId}`);
      if (res.status !== "reserved") {
        const acct = this.getAccount(res.wallet)!;
        return { charged: res.charged, balance: acct.balance, available: acct.available };
      }
      const amount = Math.max(0, Math.min(Math.floor(charged), res.amount));
      const now = this.now();
      this.db
        .prepare(
          `UPDATE accounts SET reserved = reserved - ?, balance = balance - ?, total_spent = total_spent + ?, updated_at = ?
           WHERE wallet = ?`,
        )
        .run(res.amount, amount, amount, now, res.wallet);
      this.db
        .prepare("UPDATE reservations SET status = 'finalized', charged = ?, resolved_at = ? WHERE id = ?")
        .run(amount, now, reservationId);
      if (amount > 0) {
        this.db
          .prepare("INSERT INTO journal (wallet, kind, amount, ref, created_at) VALUES (?, 'debit', ?, ?, ?)")
          .run(res.wallet, -amount, reservationId, now);
      }
      this.db
        .prepare(
          `INSERT INTO daily_usage (wallet, day, calls, spent) VALUES (?, ?, ?, ?)
           ON CONFLICT (wallet, day) DO UPDATE SET calls = calls + excluded.calls, spent = spent + excluded.spent`,
        )
        .run(res.wallet, this.day(now), amount > 0 ? calls : 0, amount);
      const acct = this.getAccount(res.wallet)!;
      return { charged: amount, balance: acct.balance, available: acct.available };
    });
  }

  release(reservationId: string): void {
    transaction(this.db, () => {
      const res = this.db.prepare("SELECT wallet, amount, status FROM reservations WHERE id = ?").get(reservationId) as
        | { wallet: string; amount: number; status: string }
        | undefined;
      if (!res || res.status !== "reserved") return;
      const now = this.now();
      this.db
        .prepare("UPDATE accounts SET reserved = reserved - ?, updated_at = ? WHERE wallet = ?")
        .run(res.amount, now, res.wallet);
      this.db
        .prepare("UPDATE reservations SET status = 'released', resolved_at = ? WHERE id = ?")
        .run(now, reservationId);
    });
  }

  /** Releases reservations left open by a crash or a hung request. */
  releaseStaleReservations(olderThanMs: number): number {
    const cutoff = this.now() - olderThanMs;
    const stale = this.db
      .prepare("SELECT id FROM reservations WHERE status = 'reserved' AND created_at < ?")
      .all(cutoff) as Array<{ id: string }>;
    for (const { id } of stale) this.release(id);
    return stale.length;
  }

  // ------------------------------------------------------------- idempotency

  idempotencyBegin(wallet: string, key: string, requestHash: string): IdempotencyBegin {
    return transaction(this.db, () => {
      const row = this.db
        .prepare("SELECT request_hash, status, http_status, headers, body FROM idempotency WHERE wallet = ? AND key = ?")
        .get(wallet, key) as
        | { request_hash: string; status: string; http_status: number | null; headers: string | null; body: string | null }
        | undefined;
      if (!row) {
        this.db
          .prepare(
            "INSERT INTO idempotency (wallet, key, request_hash, status, created_at) VALUES (?, ?, ?, 'in_flight', ?)",
          )
          .run(wallet, key, requestHash, this.now());
        return { state: "new" };
      }
      if (row.request_hash !== requestHash) return { state: "mismatch" };
      if (row.status !== "done") return { state: "in_flight" };
      return {
        state: "replay",
        status: row.http_status ?? 200,
        headers: row.headers ? (JSON.parse(row.headers) as Record<string, string>) : {},
        body: row.body ?? "",
      };
    });
  }

  idempotencyComplete(wallet: string, key: string, status: number, headers: Record<string, string>, body: string): void {
    this.db
      .prepare("UPDATE idempotency SET status = 'done', http_status = ?, headers = ?, body = ? WHERE wallet = ? AND key = ?")
      .run(status, JSON.stringify(headers), body, wallet, key);
  }

  idempotencyAbort(wallet: string, key: string): void {
    this.db.prepare("DELETE FROM idempotency WHERE wallet = ? AND key = ? AND status = 'in_flight'").run(wallet, key);
  }

  pruneIdempotency(olderThanMs = DAY_MS): number {
    return Number(this.db.prepare("DELETE FROM idempotency WHERE created_at < ?").run(this.now() - olderThanMs).changes);
  }

  // ----------------------------------------------------------------- refunds

  /** Moves `amount` (default: everything available) out of the balance into a refund request. */
  requestRefund(wallet: string, amount: Micros | undefined, destination: string): Refund {
    return transaction(this.db, () => {
      const account = this.getAccount(wallet);
      const available = account?.available ?? 0;
      const value = amount ?? available;
      if (!(value > 0)) throw new LedgerError("nothing_to_refund", "No available balance to refund");
      if (value > available) throw new LedgerError("insufficient_balance", "Refund exceeds available balance");
      const id = newId("ref");
      const now = this.now();
      this.db
        .prepare(
          `UPDATE accounts SET balance = balance - ?, total_refunded = total_refunded + ?, updated_at = ?
           WHERE wallet = ?`,
        )
        .run(value, value, now, wallet);
      this.db
        .prepare(
          `INSERT INTO refunds (id, wallet, amount, destination, status, created_at)
           VALUES (?, ?, ?, ?, 'requested', ?)`,
        )
        .run(id, wallet, value, destination, now);
      this.db
        .prepare("INSERT INTO journal (wallet, kind, amount, ref, created_at) VALUES (?, 'refund', ?, ?, ?)")
        .run(wallet, -value, id, now);
      return this.getRefund(id)!;
    });
  }

  resolveRefund(id: string, status: "paid" | "rejected", opts: { txSignature?: string; note?: string } = {}): Refund {
    return transaction(this.db, () => {
      const refund = this.getRefund(id);
      if (!refund) throw new LedgerError("not_found", `unknown refund ${id}`);
      if (refund.status !== "requested") throw new LedgerError("already_resolved", `refund ${id} is ${refund.status}`);
      const now = this.now();
      if (status === "rejected") {
        this.db
          .prepare(
            `UPDATE accounts SET balance = balance + ?, total_refunded = total_refunded - ?, updated_at = ?
             WHERE wallet = ?`,
          )
          .run(refund.amount, refund.amount, now, refund.wallet);
        this.db
          .prepare(
            "INSERT INTO journal (wallet, kind, amount, ref, note, created_at) VALUES (?, 'refund_reversal', ?, ?, ?, ?)",
          )
          .run(refund.wallet, refund.amount, id, opts.note ?? null, now);
      }
      this.db
        .prepare("UPDATE refunds SET status = ?, tx_signature = ?, note = ?, resolved_at = ? WHERE id = ?")
        .run(status, opts.txSignature ?? null, opts.note ?? null, now, id);
      return this.getRefund(id)!;
    });
  }

  getRefund(id: string): Refund | undefined {
    const row = this.db.prepare("SELECT * FROM refunds WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? toRefund(row) : undefined;
  }

  listRefunds(filter: { wallet?: string; status?: string } = {}): Refund[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.wallet) {
      where.push("wallet = ?");
      params.push(filter.wallet);
    }
    if (filter.status) {
      where.push("status = ?");
      params.push(filter.status);
    }
    const rows = this.db
      .prepare(`SELECT * FROM refunds ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT 500`)
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map(toRefund);
  }

  // ------------------------------------------------------------------- admin

  /** Manual, journaled balance correction by the operator. */
  adjust(wallet: string, amount: Micros, note: string): Account {
    if (!Number.isInteger(amount) || amount === 0) throw new LedgerError("invalid_amount", "amount must be a non-zero integer");
    return transaction(this.db, () => {
      this.ensureAccount(wallet);
      const account = this.getAccount(wallet)!;
      if (account.available + amount < 0) throw new LedgerError("insufficient_balance", "adjustment would go negative");
      const now = this.now();
      this.db
        .prepare("UPDATE accounts SET balance = balance + ?, updated_at = ? WHERE wallet = ?")
        .run(amount, now, wallet);
      this.db
        .prepare("INSERT INTO journal (wallet, kind, amount, ref, note, created_at) VALUES (?, 'adjustment', ?, ?, ?, ?)")
        .run(wallet, amount, newId("adj"), note.slice(0, 500), now);
      return this.getAccount(wallet)!;
    });
  }

  journal(wallet: string, limit = 50): Array<Record<string, unknown>> {
    return this.db
      .prepare("SELECT kind, amount, ref, note, created_at FROM journal WHERE wallet = ? ORDER BY id DESC LIMIT ?")
      .all(wallet, Math.min(limit, 500)) as Array<Record<string, unknown>>;
  }

  // ----------------------------------------------------------- reconciliation

  /**
   * Proves the ledger converges: every balance equals the sum of its journal,
   * every reserved amount equals its open reservations, stale reservations are
   * released and stuck settlements are flagged for review.
   */
  reconcile(opts: { staleReservationMs?: number; staleTopupMs?: number } = {}): ReconcileReport {
    const released = this.releaseStaleReservations(opts.staleReservationMs ?? 120_000);
    const topupCutoff = this.now() - (opts.staleTopupMs ?? 600_000);
    this.db
      .prepare(
        "UPDATE topups SET status = 'needs_review', error = COALESCE(error, 'settlement outcome unknown') WHERE status = 'settling' AND created_at < ?",
      )
      .run(topupCutoff);
    const balanceMismatches = this.db
      .prepare(
        `SELECT a.wallet AS wallet, a.balance AS balance, COALESCE(SUM(j.amount), 0) AS journalSum
         FROM accounts a LEFT JOIN journal j ON j.wallet = a.wallet
         GROUP BY a.wallet HAVING a.balance != COALESCE(SUM(j.amount), 0)`,
      )
      .all() as Array<{ wallet: string; balance: number; journalSum: number }>;
    const reservedMismatches = this.db
      .prepare(
        `SELECT a.wallet AS wallet, a.reserved AS reserved,
           COALESCE((SELECT SUM(r.amount) FROM reservations r WHERE r.wallet = a.wallet AND r.status = 'reserved'), 0) AS openReservations
         FROM accounts a
         WHERE a.reserved != COALESCE((SELECT SUM(r.amount) FROM reservations r WHERE r.wallet = a.wallet AND r.status = 'reserved'), 0)`,
      )
      .all() as Array<{ wallet: string; reserved: number; openReservations: number }>;
    const checked = (this.db.prepare("SELECT COUNT(*) AS n FROM accounts").get() as { n: number }).n;
    const review = (this.db.prepare("SELECT COUNT(*) AS n FROM topups WHERE status = 'needs_review'").get() as { n: number }).n;
    return {
      checkedAccounts: checked,
      balanceMismatches,
      reservedMismatches,
      releasedStaleReservations: released,
      topupsNeedingReview: review,
      ok: balanceMismatches.length === 0 && reservedMismatches.length === 0,
    };
  }

  // ------------------------------------------------------------ SIWx nonces

  /** Atomically marks a nonce as used. Returns false if it was already used. */
  useNonce(nonce: string, expiresAt: number): boolean {
    const res = this.db.prepare("INSERT OR IGNORE INTO siwx_nonces (nonce, expires_at) VALUES (?, ?)").run(nonce, expiresAt);
    return Number(res.changes) === 1;
  }

  pruneNonces(): number {
    return Number(this.db.prepare("DELETE FROM siwx_nonces WHERE expires_at < ?").run(this.now()).changes);
  }

  // ------------------------------------------------------------------ funnel

  recordEvent(kind: string, wallet?: string | null, subject?: string | null): void {
    this.db
      .prepare("INSERT INTO events (kind, wallet, subject, created_at) VALUES (?, ?, ?, ?)")
      .run(kind, wallet ?? null, subject ?? null, this.now());
  }

  pruneEvents(olderThanMs = 90 * DAY_MS): number {
    return Number(this.db.prepare("DELETE FROM events WHERE created_at < ?").run(this.now() - olderThanMs).changes);
  }

  stats(sinceMs?: number): Record<string, unknown> {
    const since = sinceMs ?? 0;
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) AS accounts,
           SUM(CASE WHEN total_topped_up > 0 THEN 1 ELSE 0 END) AS fundedWallets,
           SUM(CASE WHEN total_spent > 0 THEN 1 ELSE 0 END) AS spendingWallets,
           COALESCE(SUM(total_topped_up), 0) AS toppedUp,
           COALESCE(SUM(total_spent), 0) AS spent,
           COALESCE(SUM(total_refunded), 0) AS refunded,
           COALESCE(SUM(balance), 0) AS outstandingBalance,
           COALESCE(SUM(reserved), 0) AS reserved
         FROM accounts`,
      )
      .get() as Record<string, number>;
    const usage = this.db
      .prepare("SELECT COALESCE(SUM(calls), 0) AS calls, COALESCE(SUM(spent), 0) AS spent FROM daily_usage")
      .get() as Record<string, number>;
    const events = this.db
      .prepare(
        `SELECT kind, COUNT(*) AS count, COUNT(DISTINCT wallet) AS wallets, COUNT(DISTINCT subject) AS subjects
         FROM events WHERE created_at >= ? GROUP BY kind`,
      )
      .all(since) as Array<{ kind: string; count: number; wallets: number; subjects: number }>;
    const topups = this.db
      .prepare("SELECT status, COUNT(*) AS count, COALESCE(SUM(amount), 0) AS amount FROM topups GROUP BY status")
      .all() as Array<{ status: string; count: number; amount: number }>;
    return { totals, usage, events, topups };
  }
}

export class LedgerError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LedgerError";
  }
}

function toAccount(row: AccountRow): Account {
  return {
    wallet: row.wallet,
    balance: row.balance,
    reserved: row.reserved,
    available: row.balance - row.reserved,
    totalToppedUp: row.total_topped_up,
    totalSpent: row.total_spent,
    totalRefunded: row.total_refunded,
    dailyCap: row.daily_cap,
    sessionEpoch: row.session_epoch,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRefund(row: Record<string, unknown>): Refund {
  return {
    id: String(row.id),
    wallet: String(row.wallet),
    amount: Number(row.amount),
    destination: String(row.destination),
    status: row.status as Refund["status"],
    txSignature: (row.tx_signature as string | null) ?? null,
    note: (row.note as string | null) ?? null,
    createdAt: Number(row.created_at),
    resolvedAt: row.resolved_at === null || row.resolved_at === undefined ? null : Number(row.resolved_at),
  };
}
