import type { UpstreamPool } from "../routing/pool.js";
import type { Upstream } from "../routing/upstream.js";

/** What the chain says about a top-up transfer, used as evidence before an operator credits it. */
export interface TransferEvidence {
  signature: string;
  found: boolean;
  /** True when the transaction is at finalized commitment. */
  finalized: boolean;
  /** True when the transaction executed without error. */
  success: boolean;
  /** Net amount of `asset` received by `payTo`, in atomic units. */
  receivedAtomic: string;
  /** Owner whose balance of `asset` decreased the most: the payer. */
  payer?: string;
  slot?: number;
  blockTime?: number | null;
  error?: unknown;
  source?: string;
}

interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string };
}

interface ParsedTx {
  slot: number;
  blockTime?: number | null;
  meta: { err: unknown; preTokenBalances?: TokenBalance[] | null; postTokenBalances?: TokenBalance[] | null } | null;
}

/** Net token change per owner for one mint, from a transaction's pre/post balances. */
export function tokenDeltas(tx: ParsedTx, mint: string): Map<string, bigint> {
  const deltas = new Map<string, bigint>();
  const add = (list: TokenBalance[] | null | undefined, sign: bigint) => {
    for (const b of list ?? []) {
      if (b.mint !== mint || !b.owner) continue;
      deltas.set(b.owner, (deltas.get(b.owner) ?? 0n) + sign * BigInt(b.uiTokenAmount.amount));
    }
  };
  add(tx.meta?.postTokenBalances, 1n);
  add(tx.meta?.preTokenBalances, -1n);
  return deltas;
}

/**
 * Looks a top-up transaction up on-chain (Helius first, then the public pool)
 * and reports whether `payTo` received `asset`, and from whom.
 */
export async function verifyTopupTransfer(
  pool: UpstreamPool,
  args: { signature: string; payTo: string; asset: string },
): Promise<TransferEvidence> {
  const empty: TransferEvidence = { signature: args.signature, found: false, finalized: false, success: false, receivedAtomic: "0" };
  const candidates: Upstream[] = [];
  if (pool.helius?.tryTake()) candidates.push(pool.helius);
  const pub = pool.pickPublic("getTransaction", new Set());
  if (pub) candidates.push(pub);
  if (candidates.length === 0) return { ...empty, error: "no upstream available" };

  for (const commitment of ["finalized", "confirmed"] as const) {
    for (const upstream of candidates) {
      const out = await upstream.call(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "getTransaction",
          params: [args.signature, { commitment, maxSupportedTransactionVersion: 0, encoding: "jsonParsed" }],
        },
        10_000,
      );
      if (out.kind !== "ok" || !("result" in out.body)) continue;
      const tx = out.body.result as ParsedTx | null;
      if (!tx) continue;
      const deltas = tokenDeltas(tx, args.asset);
      let payer: string | undefined;
      let largestOutflow = 0n;
      for (const [owner, delta] of deltas) {
        if (owner !== args.payTo && delta < largestOutflow) {
          largestOutflow = delta;
          payer = owner;
        }
      }
      return {
        signature: args.signature,
        found: true,
        finalized: commitment === "finalized",
        success: tx.meta?.err === null || tx.meta?.err === undefined,
        receivedAtomic: (deltas.get(args.payTo) ?? 0n).toString(),
        payer,
        slot: tx.slot,
        blockTime: tx.blockTime ?? null,
        error: tx.meta?.err ?? undefined,
        source: upstream.id,
      };
    }
  }
  return empty;
}
