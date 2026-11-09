import { address, isAddress } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
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

/**
 * Upstreams for a one-off operator read (custody, top-up evidence): Helius
 * first when it has capacity, then public upstreams that serve the method,
 * healthy ones first. Health-based exclusion protects agent traffic; an
 * operator check should still ask a cooling upstream rather than report
 * "unknown". At most three public upstreams are tried.
 */
function operatorReadSources(pool: UpstreamPool, method: string): Upstream[] {
  const out: Upstream[] = [];
  if (pool.helius?.tryTake()) out.push(pool.helius);
  const healthy = pool.eligiblePublics(method, new Set());
  const others = pool.publics.filter((u) => u.serves(method) && !healthy.includes(u));
  out.push(...[...healthy, ...others].slice(0, 3));
  return out;
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

const TOKEN_2022_PROGRAM_ADDRESS = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

/** The owner's associated token accounts for a mint (classic and Token-2022), or [] if either is not an address. */
export async function associatedTokenAccounts(owner: string, mint: string): Promise<string[]> {
  if (!isAddress(owner) || !isAddress(mint)) return [];
  return Promise.all(
    [TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS].map(async (tokenProgram) => {
      const [pda] = await findAssociatedTokenPda({ owner, mint, tokenProgram });
      return String(pda);
    }),
  );
}

export type TokenHoldings =
  | {
      ok: true;
      accounts: number;
      amountAtomic: bigint;
      /**
       * Whether the owner's associated token account exists. x402 exact
       * payments are sent to it, so "missing" means top-ups would fail.
       * "unknown" when the owner or mint is not a valid address.
       */
      associatedAccount: "present" | "missing" | "unknown";
      source: string;
    }
  | { ok: false; error: string };

/**
 * Operator custody: how much of `mint` the `owner` holds across its token
 * accounts at confirmed commitment (Helius first, then the public pool), and
 * whether the associated token account that x402 payments target exists.
 */
export async function readTokenHoldings(pool: UpstreamPool, args: { owner: string; mint: string }): Promise<TokenHoldings> {
  const candidates = operatorReadSources(pool, "getTokenAccountsByOwner");
  for (const upstream of candidates) {
    const out = await upstream.call(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "getTokenAccountsByOwner",
        // Confirmed, like the settlements the ledger credits: finalized lags them by
        // ~13s, which would report a shortfall right after every top-up.
        params: [args.owner, { mint: args.mint }, { encoding: "jsonParsed", commitment: "confirmed" }],
      },
      10_000,
    );
    if (out.kind !== "ok" || !("result" in out.body)) continue;
    const value = (
      out.body.result as { value?: Array<{ pubkey?: string; account?: { data?: { parsed?: { info?: { tokenAmount?: { amount?: string } } } } } }> }
    )?.value;
    if (!Array.isArray(value)) continue;
    const amountAtomic = value.reduce((sum, a) => sum + BigInt(a.account?.data?.parsed?.info?.tokenAmount?.amount ?? "0"), 0n);
    const atas = await associatedTokenAccounts(args.owner, args.mint);
    const associatedAccount = atas.length === 0 ? "unknown" : value.some((a) => a.pubkey && atas.includes(a.pubkey)) ? "present" : "missing";
    return { ok: true, accounts: value.length, amountAtomic, associatedAccount, source: upstream.id };
  }
  return { ok: false, error: candidates.length ? "no upstream answered getTokenAccountsByOwner" : "no upstream available" };
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
  const candidates = operatorReadSources(pool, "getTransaction");
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
