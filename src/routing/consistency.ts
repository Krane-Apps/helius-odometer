import type { Commitment, MethodSpec } from "../pricing/methods.js";
import { LruCache } from "../util/lru.js";

export interface PreparedParams {
  params: unknown[] | Record<string, unknown> | undefined;
  /** Commitment the upstream will evaluate at (Solana default is finalized). */
  effectiveCommitment?: Commitment;
  injectedCommitment?: Commitment;
  injectedMinContextSlot?: number;
}

const COMMITMENTS = new Set(["processed", "confirmed", "finalized"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Normalizes positional params for cross-provider consistency:
 *  - injects the tier's default commitment when the caller set none
 *  - injects `minContextSlot` so a wallet never reads older state than it already saw
 * The caller's objects are never mutated, and explicit caller values always win.
 */
export function prepareParams(
  spec: MethodSpec,
  params: unknown[] | Record<string, unknown> | undefined,
  opts: { commitment?: Commitment; minContextSlot?: (commitment: Commitment) => number | undefined },
): PreparedParams {
  if (spec.configIndex === undefined || (params !== undefined && !Array.isArray(params))) {
    return { params };
  }
  const list = params ? [...params] : [];
  const idx = spec.configIndex;
  if (list.length < idx) return { params };
  const existing = list[idx];
  if (existing !== undefined && !isPlainObject(existing)) {
    // e.g. legacy `getTransaction(sig, "json")`: leave untouched.
    return { params };
  }
  const cfg: Record<string, unknown> = existing ? { ...existing } : {};
  let injectedCommitment: Commitment | undefined;
  let injectedMinContextSlot: number | undefined;

  if (spec.injectCommitment && opts.commitment && cfg.commitment === undefined) {
    cfg.commitment = opts.commitment;
    injectedCommitment = opts.commitment;
  }
  const effectiveCommitment: Commitment =
    typeof cfg.commitment === "string" && COMMITMENTS.has(cfg.commitment) ? (cfg.commitment as Commitment) : "finalized";

  if (spec.minContextSlot && opts.minContextSlot && cfg.minContextSlot === undefined) {
    const floor = opts.minContextSlot(effectiveCommitment);
    if (floor !== undefined && floor > 0) {
      cfg.minContextSlot = floor;
      injectedMinContextSlot = floor;
    }
  }

  if (injectedCommitment === undefined && injectedMinContextSlot === undefined) {
    return { params, effectiveCommitment };
  }
  if (existing === undefined) list[idx] = cfg;
  else list[idx] = cfg;
  return { params: list, effectiveCommitment, injectedCommitment, injectedMinContextSlot };
}

/** Extracts the evaluation slot from a response, when the method reports one. */
export function responseSlot(spec: MethodSpec, result: unknown): number | undefined {
  if (spec.contextResponse && isPlainObject(result)) {
    const ctx = result.context;
    if (isPlainObject(ctx) && typeof ctx.slot === "number") return ctx.slot;
  }
  if (spec.name === "getSlot" && typeof result === "number") return result;
  return undefined;
}

/**
 * Per-wallet high-water marks of observed slots, kept separately for each
 * commitment level (a processed slot is ~32 slots ahead of finalized, so the
 * levels must never be compared).
 */
export class SlotHighWaterMarks {
  private readonly marks = new LruCache<string, { slot: number; at: number }>(200_000);

  constructor(
    private readonly margin: number,
    private readonly maxAgeMs = 30_000,
  ) {}

  observe(wallet: string, commitment: Commitment, slot: number, now = Date.now()): void {
    const key = `${wallet}|${commitment}`;
    const cur = this.marks.get(key, now);
    if (!cur || slot > cur.slot || now - cur.at > this.maxAgeMs) this.marks.set(key, { slot, at: now }, {}, now);
  }

  /** The floor to inject as minContextSlot, or undefined when the mark is stale. */
  floor(wallet: string, commitment: Commitment, now = Date.now()): number | undefined {
    const cur = this.marks.get(`${wallet}|${commitment}`, now);
    if (!cur || now - cur.at > this.maxAgeMs) return undefined;
    return Math.max(0, cur.slot - this.margin);
  }
}

/** Wallets that recently sent a transaction get their follow-up status reads pinned to Helius. */
export class TxSessions {
  private readonly sessions = new LruCache<string, number>(100_000);

  constructor(private readonly ttlMs = 90_000) {}

  touch(wallet: string, now = Date.now()): void {
    this.sessions.set(wallet, now + this.ttlMs, { ttlMs: this.ttlMs }, now);
  }

  active(wallet: string, now = Date.now()): boolean {
    const until = this.sessions.get(wallet, now);
    return until !== undefined && until > now;
  }
}

/** Reads that should follow a wallet's in-flight transaction to the same upstream. */
export const TX_FOLLOWUP_METHODS = new Set([
  "getSignatureStatuses",
  "getLatestBlockhash",
  "getBlockHeight",
  "isBlockhashValid",
  "getTransaction",
]);
