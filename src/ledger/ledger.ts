import type { StatementSync } from "node:sqlite";
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
  | { status: "duplicate-in-flight"; id: string }
  | { status: "under-review"; id: string };

export interface TopupRow {
  id: string;
  wallet: string | null;
  amount: Micros;
  network: string;
  asset: string;
  payload_hash: string;
  tx_signature: string | null;
  status: "settling" | "settled" | "failed" | "needs_review" | "rejected";
  error: string | null;
  created_at: number;
  settled_at: number | null;
  resolution: string | null;
  resolution_note: string | null;
  resolved_at: number | null;
}

export type ReserveResult =
  | { ok: true; reservationId: string; available: Micros }
  | { ok: false; reason: "insufficient_balance"; available: Micros }
  | { ok: false; reason: "daily_cap_exceeded"; available: Micros; cap: Micros; spentToday: Micros };

/**
 * The replay receipt written in the same transaction as a request's debit, so
 * a crash can never leave a charged request without its stored response.
 */
export type FinalizeReceipt =
  | { wallet: string; key: string; requestId: string; status: number; headers: Record<string, string>; body: string }
  | { wallet: string; key: string; requestId: string; abort: true };

export interface RequestReceipt {
  requestId: string | null;
  /** in_flight: still running (or interrupted before charging); charged; not_charged. */
  state: "in_flight" | "charged" | "not_charged";
  chargedMicros: number;
  tier?: string;
  methods?: string[];
  idempotencyKey?: string;
  httpStatus?: number | null;
  createdAt: number;
  resolvedAt?: number | null;
}

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
  /** Top-ups whose outcome is unknown: possible money owed that the arithmetic cannot see. */
  unresolvedTopups: { count: number; amountMicros: Micros };
  /** Refunds requested but not yet paid out: owed to agents. */
  pendingRefunds: { count: number; amountMicros: Micros };
  /** What the operator owes agents: balances plus pending refunds (excludes unresolved top-ups). */
  liabilitiesMicros: Micros;
  /** Balances equal their journal and reserved amounts equal open reservations. */
  arithmeticOk: boolean;
  /**
   * Arithmetic holds and nothing is unresolved. This is a local consistency
   * check: it does not read the chain or prove custody (see GET /admin/readiness).
   */
  ok: boolean;
  warnings: string[];
}

export interface LedgerOptions {
  path: string;
  /**
   * Operator ceiling on what any wallet may spend per UTC day, in micros.
   * `null` means no operator ceiling; `0` means nobody may spend.
   */
  defaultDailyCap: Micros | null;
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
  private readonly defaultDailyCap: Micros | null;

  /** Prepared statements are compiled once and reused; preparing per call dominated CPU time. */
  private readonly statements = new Map<string, StatementSync>();

  constructor(opts: LedgerOptions) {
    this.db = openDb(opts.path);
    this.now = opts.now ?? Date.now;
    this.defaultDailyCap = opts.defaultDailyCap;
  }

  private q(sql: string): StatementSync {
    let stmt = this.statements.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.statements.set(sql, stmt);
    }
    return stmt;
  }

  close(): void {
    this.db.close();
  }

  private day(ts = this.now()): string {
    return new Date(ts).toISOString().slice(0, 10);
  }

  // ---------------------------------------------------------------- accounts

  getAccount(wallet: string): Account | undefined {
    const row = this.q("SELECT * FROM accounts WHERE wallet = ?").get(wallet) as AccountRow | undefined;
    return row ? toAccount(row) : undefined;
  }

  available(wallet: string): Micros {
    return this.getAccount(wallet)?.available ?? 0;
  }

  spentToday(wallet: string): Micros {
    const row = this.q("SELECT spent FROM daily_usage WHERE wallet = ? AND day = ?")
      .get(wallet, this.day()) as { spent: number } | undefined;
    return row?.spent ?? 0;
  }

  /**
   * The cap that applies to a wallet today: the tighter of the operator ceiling
   * and the wallet's own cap. `null` means unlimited; `0` means no spending.
   * A wallet's own cap can only tighten the operator ceiling, never remove it.
   */
  effectiveDailyCap(account: Pick<Account, "dailyCap"> | undefined): Micros | null {
    const caps = [this.defaultDailyCap, account?.dailyCap ?? null].filter((c): c is Micros => c !== null);
    return caps.length ? Math.min(...caps) : null;
  }

  operatorDailyCap(): Micros | null {
    return this.defaultDailyCap;
  }

  private ensureAccount(wallet: string): void {
    const now = this.now();
    this.q("INSERT OR IGNORE INTO accounts (wallet, created_at, updated_at) VALUES (?, ?, ?)")
      .run(wallet, now, now);
  }

  /**
   * Sets a wallet's own daily cap: a positive amount, `0` to stop spending, or
   * `null` to remove the wallet's own cap (the operator ceiling still applies).
   */
  setDailyCap(wallet: string, cap: Micros | null): Account {
    if (cap !== null && !(Number.isInteger(cap) && cap >= 0)) throw new LedgerError("invalid_cap", "cap must be a non-negative integer or null");
    return transaction(this.db, () => {
      this.ensureAccount(wallet);
      this.q("UPDATE accounts SET daily_cap = ?, updated_at = ? WHERE wallet = ?").run(cap, this.now(), wallet);
      return this.getAccount(wallet)!;
    });
  }

  /** Invalidates every session token issued to this wallet so far. */
  bumpSessionEpoch(wallet: string): number {
    return transaction(this.db, () => {
      this.ensureAccount(wallet);
      this.q("UPDATE accounts SET session_epoch = session_epoch + 1, updated_at = ? WHERE wallet = ?")
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
      const row = this.q("SELECT id, status, tx_signature FROM topups WHERE payload_hash = ?")
        .get(args.payloadHash) as { id: string; status: string; tx_signature: string | null } | undefined;
      if (row?.status === "settled") return { status: "duplicate-settled", id: row.id, txSignature: row.tx_signature };
      if (row?.status === "settling") return { status: "duplicate-in-flight", id: row.id };
      // An ambiguous settlement may still land; it stays frozen until an operator resolves it.
      if (row?.status === "needs_review" || row?.status === "rejected") return { status: "under-review", id: row.id };
      if (row) {
        this.q("UPDATE topups SET status = 'settling', error = NULL WHERE id = ?").run(row.id);
        return { status: "new", id: row.id };
      }
      const id = newId("top");
      this.q(
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
      const bySig = this.q("SELECT id, payload_hash, status FROM topups WHERE tx_signature = ?")
        .get(args.txSignature) as { id: string; payload_hash: string; status: string } | undefined;
      if (bySig && bySig.status === "settled") {
        return { credited: false, topupId: bySig.id, balance: this.getAccount(args.wallet)?.balance ?? 0 };
      }
      let row = this.q("SELECT id, status FROM topups WHERE payload_hash = ?").get(args.payloadHash) as
        | { id: string; status: string }
        | undefined;
      if (row?.status === "settled") {
        return { credited: false, topupId: row.id, balance: this.getAccount(args.wallet)?.balance ?? 0 };
      }
      const now = this.now();
      if (row?.status === "rejected") {
        this.q(
          "UPDATE topups SET status = 'needs_review', error = ?, wallet = ?, tx_signature = COALESCE(tx_signature, ?) WHERE id = ?",
        ).run("late settlement after operator rejection", args.wallet, args.txSignature, row.id);
        return { credited: false, topupId: row.id, balance: this.getAccount(args.wallet)?.balance ?? 0 };
      }
      if (!row) {
        const id = newId("top");
        this.q(
            `INSERT INTO topups (id, amount, network, asset, payload_hash, status, created_at)
             VALUES (?, ?, ?, ?, ?, 'settling', ?)`,
          )
          .run(id, args.amount, args.network, args.asset, args.payloadHash, now);
        row = { id, status: "settling" };
      }
      this.q(
          `UPDATE topups SET status = 'settled', wallet = ?, tx_signature = ?, amount = ?, settled_at = ?, error = NULL
           WHERE id = ?`,
        )
        .run(args.wallet, args.txSignature, args.amount, now, row.id);
      this.ensureAccount(args.wallet);
      this.q(
          `UPDATE accounts SET balance = balance + ?, total_topped_up = total_topped_up + ?, updated_at = ?
           WHERE wallet = ?`,
        )
        .run(args.amount, args.amount, now, args.wallet);
      this.q("INSERT INTO journal (wallet, kind, amount, ref, note, created_at) VALUES (?, 'topup', ?, ?, ?, ?)")
        .run(args.wallet, args.amount, row.id, args.txSignature, now);
      return { credited: true, topupId: row.id, balance: this.getAccount(args.wallet)!.balance };
    });
  }

  getTopup(id: string): TopupRow | undefined {
    return this.q("SELECT * FROM topups WHERE id = ?").get(id) as TopupRow | undefined;
  }

  /**
   * Top-ups that could still credit this wallet: settling (the payer is not
   * known until settlement answers, so any wallet's), or awaiting review.
   */
  openTopupsFor(wallet: string): TopupRow[] {
    return this.q(
      "SELECT * FROM topups WHERE status IN ('settling', 'needs_review') AND (wallet = ? OR wallet IS NULL) ORDER BY created_at",
    ).all(wallet) as unknown as TopupRow[];
  }

  /** Top-ups whose outcome is unknown: settling past the stale window, or under review. */
  unresolvedTopups(staleMs = 600_000): TopupRow[] {
    return this.q("SELECT * FROM topups WHERE status = 'needs_review' OR (status = 'settling' AND created_at < ?) ORDER BY created_at")
      .all(this.now() - staleMs) as unknown as TopupRow[];
  }

  /**
   * Operator resolution of an unresolved top-up, applied to the original
   * receipt so it can be credited at most once:
   *  - credit: the receipt itself becomes settled (amount from the receipt,
   *    never from the operator); a later completion or replay of the same
   *    payload or signature finds it settled and credits nothing;
   *  - reject: no money moved; a later settlement of the same payload goes
   *    back to review instead of crediting automatically.
   * Never resolve a top-up with a generic adjustment: that leaves this
   * receipt eligible for a second credit.
   */
  resolveTopup(
    args:
      | { topupId: string; action: "credit"; wallet: string; txSignature: string; note: string }
      | { topupId: string; action: "reject"; note: string },
  ): { topup: TopupRow; credited: boolean; balance?: Micros } {
    if (!args.note.trim()) throw new LedgerError("note_required", "a resolution note is required");
    return transaction(this.db, () => {
      const row = this.getTopup(args.topupId);
      if (!row) throw new LedgerError("not_found", `unknown top-up ${args.topupId}`);
      if (row.status === "settled") throw new LedgerError("already_settled", `top-up ${row.id} is already credited`);
      const now = this.now();
      if (args.action === "reject") {
        this.q("UPDATE topups SET status = 'rejected', resolution = 'operator_reject', resolution_note = ?, resolved_at = ? WHERE id = ?")
          .run(args.note.slice(0, 500), now, row.id);
        return { topup: this.getTopup(row.id)!, credited: false };
      }
      if (row.status === "settling") throw new LedgerError("still_settling", `top-up ${row.id} is still settling; wait or let reconciliation flag it`);
      const other = this.q("SELECT id FROM topups WHERE tx_signature = ? AND id != ? AND status = 'settled'")
        .get(args.txSignature, row.id) as { id: string } | undefined;
      if (other) throw new LedgerError("signature_already_credited", `signature already credited to top-up ${other.id}`);
      this.q(
        `UPDATE topups SET status = 'settled', wallet = ?, tx_signature = ?, settled_at = ?, error = NULL,
           resolution = 'operator_credit', resolution_note = ?, resolved_at = ?
         WHERE id = ? AND status != 'settled'`,
      ).run(args.wallet, args.txSignature, now, args.note.slice(0, 500), now, row.id);
      this.ensureAccount(args.wallet);
      this.q("UPDATE accounts SET balance = balance + ?, total_topped_up = total_topped_up + ?, updated_at = ? WHERE wallet = ?")
        .run(row.amount, row.amount, now, args.wallet);
      this.q("INSERT INTO journal (wallet, kind, amount, ref, note, created_at) VALUES (?, 'topup', ?, ?, ?, ?)")
        .run(args.wallet, row.amount, row.id, `operator credit ${args.txSignature}: ${args.note}`.slice(0, 500), now);
      return { topup: this.getTopup(row.id)!, credited: true, balance: this.getAccount(args.wallet)!.balance };
    });
  }

  failTopup(payloadHash: string, error: string): void {
    this.q("UPDATE topups SET status = 'failed', error = ? WHERE payload_hash = ? AND status = 'settling'")
      .run(error.slice(0, 500), payloadHash);
  }

  markTopupNeedsReview(payloadHash: string, error: string, details?: { wallet?: string; txSignature?: string }): void {
    this.q(
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
    return this.q(sql).all(...params) as Array<Record<string, unknown>>;
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
      if (cap !== null && spentToday + account.reserved + args.amount > cap) {
        return { ok: false, reason: "daily_cap_exceeded", available, cap, spentToday };
      }
      const id = newId("res");
      const now = this.now();
      this.q("UPDATE accounts SET reserved = reserved + ?, updated_at = ? WHERE wallet = ?")
        .run(args.amount, now, args.wallet);
      this.q(
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
  finalize(
    reservationId: string,
    charged: Micros,
    calls = 1,
    receipt?: FinalizeReceipt,
  ): { charged: Micros; balance: Micros; available: Micros } {
    return transaction(this.db, () => {
      const res = this.q("SELECT wallet, amount, status, charged FROM reservations WHERE id = ?")
        .get(reservationId) as { wallet: string; amount: number; status: string; charged: number } | undefined;
      if (!res) throw new Error(`unknown reservation ${reservationId}`);
      if (res.status !== "reserved") {
        const acct = this.getAccount(res.wallet)!;
        return { charged: res.charged, balance: acct.balance, available: acct.available };
      }
      const amount = Math.max(0, Math.min(Math.floor(charged), res.amount));
      const now = this.now();
      this.q(
          `UPDATE accounts SET reserved = reserved - ?, balance = balance - ?, total_spent = total_spent + ?, updated_at = ?
           WHERE wallet = ?`,
        )
        .run(res.amount, amount, amount, now, res.wallet);
      this.q("UPDATE reservations SET status = 'finalized', charged = ?, resolved_at = ? WHERE id = ?")
        .run(amount, now, reservationId);
      if (amount > 0) {
        this.q("INSERT INTO journal (wallet, kind, amount, ref, created_at) VALUES (?, 'debit', ?, ?, ?)")
          .run(res.wallet, -amount, reservationId, now);
      }
      this.q(
          `INSERT INTO daily_usage (wallet, day, calls, spent) VALUES (?, ?, ?, ?)
           ON CONFLICT (wallet, day) DO UPDATE SET calls = calls + excluded.calls, spent = spent + excluded.spent`,
        )
        .run(res.wallet, this.day(now), amount > 0 ? calls : 0, amount);
      if (receipt) this.writeReceipt(receipt, amount);
      const acct = this.getAccount(res.wallet)!;
      return { charged: amount, balance: acct.balance, available: acct.available };
    });
  }

  /** Stores (or aborts) an idempotency receipt; must run inside the debit's transaction. */
  private writeReceipt(receipt: FinalizeReceipt, charged: Micros): void {
    // A charged request always keeps its receipt, so a retry can never be charged twice.
    if ("abort" in receipt && charged === 0) {
      this.q("UPDATE idempotency SET status = 'aborted', request_id = ?, charged = 0 WHERE wallet = ? AND key = ? AND status = 'in_flight'")
        .run(receipt.requestId, receipt.wallet, receipt.key);
      return;
    }
    const status = "abort" in receipt ? 500 : receipt.status;
    const headers = "abort" in receipt ? {} : receipt.headers;
    const body = "abort" in receipt ? JSON.stringify({ error: "request_failed_after_charge", requestId: receipt.requestId }) : receipt.body;
    this.q(
      `UPDATE idempotency SET status = 'done', http_status = ?, headers = ?, body = ?, request_id = ?, charged = ?
       WHERE wallet = ? AND key = ? AND status = 'in_flight'`,
    ).run(status, JSON.stringify(headers), body, receipt.requestId, charged, receipt.wallet, receipt.key);
  }

  release(reservationId: string, receipt?: { wallet: string; key: string; requestId: string }): void {
    transaction(this.db, () => {
      if (receipt) this.writeReceipt({ ...receipt, abort: true }, 0);
      const res = this.q("SELECT wallet, amount, status FROM reservations WHERE id = ?").get(reservationId) as
        | { wallet: string; amount: number; status: string }
        | undefined;
      if (!res || res.status !== "reserved") return;
      const now = this.now();
      this.q("UPDATE accounts SET reserved = reserved - ?, updated_at = ? WHERE wallet = ?")
        .run(res.amount, now, res.wallet);
      this.q("UPDATE reservations SET status = 'released', resolved_at = ? WHERE id = ?")
        .run(now, reservationId);
    });
  }

  /** Releases reservations left open by a crash or a hung request. */
  releaseStaleReservations(olderThanMs: number): number {
    const cutoff = this.now() - olderThanMs;
    const stale = this.q("SELECT id FROM reservations WHERE status = 'reserved' AND created_at < ?")
      .all(cutoff) as Array<{ id: string }>;
    for (const { id } of stale) this.release(id);
    return stale.length;
  }

  // ------------------------------------------------------------- idempotency

  idempotencyBegin(wallet: string, key: string, requestHash: string): IdempotencyBegin {
    return transaction(this.db, () => {
      const row = this.q("SELECT request_hash, status, http_status, headers, body FROM idempotency WHERE wallet = ? AND key = ?")
        .get(wallet, key) as
        | { request_hash: string; status: string; http_status: number | null; headers: string | null; body: string | null }
        | undefined;
      if (!row) {
        this.q(
            "INSERT INTO idempotency (wallet, key, request_hash, status, created_at) VALUES (?, ?, ?, 'in_flight', ?)",
          )
          .run(wallet, key, requestHash, this.now());
        return { state: "new" };
      }
      if (row.request_hash !== requestHash) return { state: "mismatch" };
      if (row.status === "aborted") {
        // The earlier attempt was never charged (it failed, or the process restarted first): run it again.
        this.q("UPDATE idempotency SET status = 'in_flight', created_at = ? WHERE wallet = ? AND key = ?").run(this.now(), wallet, key);
        return { state: "new" };
      }
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
    this.q("UPDATE idempotency SET status = 'done', http_status = ?, headers = ?, body = ? WHERE wallet = ? AND key = ?")
      .run(status, JSON.stringify(headers), body, wallet, key);
  }

  idempotencyAbort(wallet: string, key: string): void {
    this.q("UPDATE idempotency SET status = 'aborted' WHERE wallet = ? AND key = ? AND status = 'in_flight'").run(wallet, key);
  }

  /**
   * What happened to a request, by the gateway's request id or by the caller's
   * idempotency key. Lets a client whose response was lost find out whether it
   * was charged, and replay it with the same key to get the stored response.
   */
  getReceipt(wallet: string, by: { requestId: string } | { idempotencyKey: string }): RequestReceipt | undefined {
    let requestId: string | null;
    let idem: { key: string; status: string; http_status: number | null; charged: number | null; created_at: number } | undefined;
    if ("idempotencyKey" in by) {
      const row = this.q("SELECT key, status, http_status, charged, created_at, request_id FROM idempotency WHERE wallet = ? AND key = ?")
        .get(wallet, by.idempotencyKey) as (typeof idem & { request_id: string | null }) | undefined;
      if (!row) return undefined;
      idem = row;
      requestId = row.request_id;
    } else {
      requestId = by.requestId;
    }
    const res = requestId
      ? (this.q("SELECT request_id, status, charged, tier, methods, created_at, resolved_at FROM reservations WHERE request_id = ? AND wallet = ?")
          .get(requestId, wallet) as
          | { request_id: string; status: string; charged: number; tier: string; methods: string; created_at: number; resolved_at: number | null }
          | undefined)
      : undefined;
    if (!res && !idem) return undefined;
    const state: RequestReceipt["state"] = res
      ? res.status === "reserved"
        ? "in_flight"
        : res.charged > 0
          ? "charged"
          : "not_charged"
      : idem!.status === "in_flight"
        ? "in_flight"
        : (idem!.charged ?? 0) > 0
          ? "charged"
          : "not_charged";
    return {
      requestId: requestId ?? null,
      state,
      chargedMicros: res?.charged ?? idem?.charged ?? 0,
      tier: res?.tier,
      methods: res?.methods ? res.methods.split(",") : undefined,
      idempotencyKey: idem?.key,
      httpStatus: idem?.http_status,
      createdAt: res?.created_at ?? idem!.created_at,
      resolvedAt: res?.resolved_at,
    };
  }

  /**
   * Startup recovery after a crash or restart: open reservations can never be
   * finalized, so they are released (not charged), and their idempotency keys
   * are marked aborted so the same request can be retried.
   */
  recoverAfterRestart(): { releasedReservations: number; abortedReceipts: number } {
    // Every open reservation, whatever its timestamp: one made in the same
    // millisecond, or "in the future" after the clock stepped back, is just as dead.
    const open = this.q("SELECT id FROM reservations WHERE status = 'reserved'").all() as Array<{ id: string }>;
    for (const { id } of open) this.release(id);
    const aborted = Number(this.q("UPDATE idempotency SET status = 'aborted' WHERE status = 'in_flight'").run().changes);
    return { releasedReservations: open.length, abortedReceipts: aborted };
  }

  /** Drops resolved reservations older than the cutoff; debits stay in the journal. */
  pruneReservations(olderThanMs: number): number {
    return Number(
      this.q("DELETE FROM reservations WHERE status != 'reserved' AND created_at < ?").run(this.now() - olderThanMs).changes,
    );
  }

  // ------------------------------------------------------- single writer

  /**
   * Claims the ledger for one gateway process. SQLite plus in-memory sessions,
   * rate limits and reservations assume a single writer; a second live process
   * against the same database is refused instead of silently racing it.
   */
  acquireWriterLock(owner: string, staleMs = 30_000): void {
    transaction(this.db, () => {
      const row = this.q("SELECT owner, heartbeat_at FROM instance_lock WHERE id = 1").get() as
        | { owner: string; heartbeat_at: number }
        | undefined;
      const now = this.now();
      if (row && row.owner !== owner && now - row.heartbeat_at < staleMs) {
        throw new LedgerError(
          "ledger_locked",
          `Another gateway process (${row.owner}) is using this ledger; its heartbeat is ${Math.round((now - row.heartbeat_at) / 1000)}s old. Run one writer per database.`,
        );
      }
      this.q(
        "INSERT INTO instance_lock (id, owner, heartbeat_at) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET owner = excluded.owner, heartbeat_at = excluded.heartbeat_at",
      ).run(owner, now);
    });
  }

  /** Refreshes the writer lock; returns false if another process took it over. */
  heartbeatWriterLock(owner: string): boolean {
    return Number(this.q("UPDATE instance_lock SET heartbeat_at = ? WHERE id = 1 AND owner = ?").run(this.now(), owner).changes) === 1;
  }

  releaseWriterLock(owner: string): void {
    this.q("DELETE FROM instance_lock WHERE id = 1 AND owner = ?").run(owner);
  }

  /** Writes a consistent snapshot of the whole ledger to `path` (SQLite VACUUM INTO). */
  backup(path: string): void {
    this.db.prepare("VACUUM INTO ?").run(path);
  }

  pruneIdempotency(olderThanMs = DAY_MS): number {
    return Number(this.q("DELETE FROM idempotency WHERE created_at < ?").run(this.now() - olderThanMs).changes);
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
      this.q(
          `UPDATE accounts SET balance = balance - ?, total_refunded = total_refunded + ?, updated_at = ?
           WHERE wallet = ?`,
        )
        .run(value, value, now, wallet);
      this.q(
          `INSERT INTO refunds (id, wallet, amount, destination, status, created_at)
           VALUES (?, ?, ?, ?, 'requested', ?)`,
        )
        .run(id, wallet, value, destination, now);
      this.q("INSERT INTO journal (wallet, kind, amount, ref, created_at) VALUES (?, 'refund', ?, ?, ?)")
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
        this.q(
            `UPDATE accounts SET balance = balance + ?, total_refunded = total_refunded - ?, updated_at = ?
             WHERE wallet = ?`,
          )
          .run(refund.amount, refund.amount, now, refund.wallet);
        this.q(
            "INSERT INTO journal (wallet, kind, amount, ref, note, created_at) VALUES (?, 'refund_reversal', ?, ?, ?, ?)",
          )
          .run(refund.wallet, refund.amount, id, opts.note ?? null, now);
      }
      this.q("UPDATE refunds SET status = ?, tx_signature = ?, note = ?, resolved_at = ? WHERE id = ?")
        .run(status, opts.txSignature ?? null, opts.note ?? null, now, id);
      return this.getRefund(id)!;
    });
  }

  getRefund(id: string): Refund | undefined {
    const row = this.q("SELECT * FROM refunds WHERE id = ?").get(id) as Record<string, unknown> | undefined;
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
    const rows = this.q(`SELECT * FROM refunds ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT 500`)
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map(toRefund);
  }

  // ------------------------------------------------------------------- admin

  /**
   * Manual, journaled balance correction by the operator. A credit is refused
   * while a top-up that could credit this wallet is unresolved: recovering a
   * payment this way would let its receipt be credited again later. Use
   * resolveTopup for that; acknowledge only credits unrelated to a top-up.
   */
  adjust(wallet: string, amount: Micros, note: string, opts: { acknowledgeUnresolvedTopups?: boolean } = {}): Account {
    if (!Number.isInteger(amount) || amount === 0) throw new LedgerError("invalid_amount", "amount must be a non-zero integer");
    return transaction(this.db, () => {
      if (amount > 0 && !opts.acknowledgeUnresolvedTopups) {
        const open = this.openTopupsFor(wallet);
        if (open.length) {
          throw new LedgerError(
            "unresolved_topups",
            `${open.length} top-up(s) that could credit this wallet are unresolved (${open.map((t) => t.id).join(", ")}); resolve them with resolveTopup, which credits the original receipt once`,
          );
        }
      }
      this.ensureAccount(wallet);
      const account = this.getAccount(wallet)!;
      if (account.available + amount < 0) throw new LedgerError("insufficient_balance", "adjustment would go negative");
      const now = this.now();
      this.q("UPDATE accounts SET balance = balance + ?, updated_at = ? WHERE wallet = ?")
        .run(amount, now, wallet);
      this.q("INSERT INTO journal (wallet, kind, amount, ref, note, created_at) VALUES (?, 'adjustment', ?, ?, ?, ?)")
        .run(wallet, amount, newId("adj"), note.slice(0, 500), now);
      return this.getAccount(wallet)!;
    });
  }

  journal(wallet: string, limit = 50): Array<Record<string, unknown>> {
    return this.q("SELECT kind, amount, ref, note, created_at FROM journal WHERE wallet = ? ORDER BY id DESC LIMIT ?")
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
    this.q(
        "UPDATE topups SET status = 'needs_review', error = COALESCE(error, 'settlement outcome unknown') WHERE status = 'settling' AND created_at < ?",
      )
      .run(topupCutoff);
    const balanceMismatches = this.q(
        `SELECT a.wallet AS wallet, a.balance AS balance, COALESCE(SUM(j.amount), 0) AS journalSum
         FROM accounts a LEFT JOIN journal j ON j.wallet = a.wallet
         GROUP BY a.wallet HAVING a.balance != COALESCE(SUM(j.amount), 0)`,
      )
      .all() as Array<{ wallet: string; balance: number; journalSum: number }>;
    const reservedMismatches = this.q(
        `SELECT a.wallet AS wallet, a.reserved AS reserved,
           COALESCE((SELECT SUM(r.amount) FROM reservations r WHERE r.wallet = a.wallet AND r.status = 'reserved'), 0) AS openReservations
         FROM accounts a
         WHERE a.reserved != COALESCE((SELECT SUM(r.amount) FROM reservations r WHERE r.wallet = a.wallet AND r.status = 'reserved'), 0)`,
      )
      .all() as Array<{ wallet: string; reserved: number; openReservations: number }>;
    const checked = (this.q("SELECT COUNT(*) AS n FROM accounts").get() as { n: number }).n;
    const review = (this.q("SELECT COUNT(*) AS n FROM topups WHERE status = 'needs_review'").get() as { n: number }).n;
    const unresolved = this.q(
      "SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS amount FROM topups WHERE status = 'needs_review' OR (status = 'settling' AND created_at < ?)",
    ).get(topupCutoff) as { n: number; amount: number };
    const refunds = this.q("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS amount FROM refunds WHERE status = 'requested'").get() as {
      n: number;
      amount: number;
    };
    const balances = (this.q("SELECT COALESCE(SUM(balance), 0) AS b FROM accounts").get() as { b: number }).b;
    const arithmeticOk = balanceMismatches.length === 0 && reservedMismatches.length === 0;
    const warnings: string[] = [];
    if (!arithmeticOk) warnings.push("ledger arithmetic mismatch: stop traffic and investigate");
    if (unresolved.n > 0) warnings.push(`${unresolved.n} top-up(s) with unknown outcome need operator review`);
    if (refunds.n > 0) warnings.push(`${refunds.n} refund(s) awaiting payout`);
    return {
      checkedAccounts: checked,
      balanceMismatches,
      reservedMismatches,
      releasedStaleReservations: released,
      topupsNeedingReview: review,
      unresolvedTopups: { count: unresolved.n, amountMicros: unresolved.amount },
      pendingRefunds: { count: refunds.n, amountMicros: refunds.amount },
      liabilitiesMicros: balances + refunds.amount,
      arithmeticOk,
      ok: arithmeticOk && unresolved.n === 0,
      warnings,
    };
  }

  // ------------------------------------------------------------ SIWx nonces

  /** Atomically marks a nonce as used. Returns false if it was already used. */
  useNonce(nonce: string, expiresAt: number): boolean {
    const res = this.q("INSERT OR IGNORE INTO siwx_nonces (nonce, expires_at) VALUES (?, ?)").run(nonce, expiresAt);
    return Number(res.changes) === 1;
  }

  pruneNonces(): number {
    return Number(this.q("DELETE FROM siwx_nonces WHERE expires_at < ?").run(this.now()).changes);
  }

  // ------------------------------------------------------------------ funnel

  recordEvent(kind: string, wallet?: string | null, subject?: string | null): void {
    this.q("INSERT INTO events (kind, wallet, subject, created_at) VALUES (?, ?, ?, ?)")
      .run(kind, wallet ?? null, subject ?? null, this.now());
  }

  pruneEvents(olderThanMs = 90 * DAY_MS): number {
    return Number(this.q("DELETE FROM events WHERE created_at < ?").run(this.now() - olderThanMs).changes);
  }

  stats(sinceMs?: number): Record<string, unknown> {
    const since = sinceMs ?? 0;
    const totals = this.q(
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
    const usage = this.q("SELECT COALESCE(SUM(calls), 0) AS calls, COALESCE(SUM(spent), 0) AS spent FROM daily_usage")
      .get() as Record<string, number>;
    const events = this.q(
        `SELECT kind, COUNT(*) AS count, COUNT(DISTINCT wallet) AS wallets, COUNT(DISTINCT subject) AS subjects
         FROM events WHERE created_at >= ? GROUP BY kind`,
      )
      .all(since) as Array<{ kind: string; count: number; wallets: number; subjects: number }>;
    const topups = this.q("SELECT status, COUNT(*) AS count, COALESCE(SUM(amount), 0) AS amount FROM topups GROUP BY status")
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
