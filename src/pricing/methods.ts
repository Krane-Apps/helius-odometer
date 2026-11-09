/**
 * Method catalog. Every JSON-RPC method the gateway will forward is listed
 * here; anything else is rejected with "method not found" so the gateway can
 * never be used as an open proxy for arbitrary upstream methods.
 *
 * Classes (see docs/PLAN.md):
 *   A  public-eligible reads: may be served by the free public pool
 *   B  Helius-only for availability: DAS, getProgramAccounts family, indexes
 *   C  Helius-only for landing: sendTransaction, simulateTransaction
 *   D  blocked: never forwarded
 *
 * `credits` is the Helius credit cost per call. Values marked
 * `creditsVerified: false` are estimates and only feed margin reporting.
 */
export type MethodClass = "A" | "B" | "C" | "D";
export type Commitment = "processed" | "confirmed" | "finalized";

export interface MethodSpec {
  readonly name: string;
  readonly cls: MethodClass;
  readonly credits: number;
  readonly creditsVerified: boolean;
  /** Price multiplier for class A methods with heavy responses. */
  readonly weight: number;
  /** Index of the trailing config object in positional params, if any. */
  readonly configIndex?: number;
  /** Gateway may inject a default commitment for this method. */
  readonly injectCommitment?: boolean;
  /** Method accepts `minContextSlot` in its config object. */
  readonly minContextSlot?: boolean;
  /** Result is `{ context: { slot }, value }`. */
  readonly contextResponse?: boolean;
  /** Responses at `finalized` commitment are immutable and cacheable. */
  readonly cacheableWhenFinalized?: boolean;
  /** Short note shown in /pricing. */
  readonly note?: string;
}

type Def = Partial<Omit<MethodSpec, "name" | "cls">> & { cls: MethodClass };

const A = (extra: Partial<Def> = {}): Def => ({ cls: "A", ...extra });
const B = (credits: number, extra: Partial<Def> = {}): Def => ({ cls: "B", credits, ...extra });

const STATE_READ = { injectCommitment: true, minContextSlot: true, contextResponse: true };

const DEFS: Record<string, Def> = {
  // ---- Class A: standard reads that any full RPC node can serve ----
  getAccountInfo: A({ configIndex: 1, ...STATE_READ }),
  getBalance: A({ configIndex: 1, ...STATE_READ }),
  getMultipleAccounts: A({ configIndex: 1, ...STATE_READ, weight: 2 }),
  getTokenAccountBalance: A({ configIndex: 1, injectCommitment: true, contextResponse: true }),
  getTokenSupply: A({ configIndex: 1, injectCommitment: true, contextResponse: true }),
  getLatestBlockhash: A({ configIndex: 0, ...STATE_READ }),
  isBlockhashValid: A({ configIndex: 1, ...STATE_READ }),
  getFeeForMessage: A({ configIndex: 1, ...STATE_READ }),
  getSlot: A({ configIndex: 0, injectCommitment: true, minContextSlot: true }),
  getBlockHeight: A({ configIndex: 0, injectCommitment: true, minContextSlot: true }),
  getEpochInfo: A({ configIndex: 0, injectCommitment: true, minContextSlot: true }),
  getTransactionCount: A({ configIndex: 0, injectCommitment: true, minContextSlot: true }),
  getSlotLeader: A({ configIndex: 0, injectCommitment: true, minContextSlot: true }),
  getMinimumBalanceForRentExemption: A({ configIndex: 1, injectCommitment: true }),
  getStakeMinimumDelegation: A({ configIndex: 0, injectCommitment: true, contextResponse: true }),
  getInflationGovernor: A({ configIndex: 0, injectCommitment: true }),
  getSignatureStatuses: A({ configIndex: 1, contextResponse: true }),
  getTransaction: A({ configIndex: 1, cacheableWhenFinalized: true, weight: 2 }),
  getBlock: A({ configIndex: 1, cacheableWhenFinalized: true, weight: 5 }),
  getBlockTime: A(),
  getBlocks: A({ weight: 2 }),
  getBlocksWithLimit: A({ configIndex: 2, weight: 2 }),
  getBlockCommitment: A(),
  getBlockProduction: A({ configIndex: 0, contextResponse: true, weight: 5 }),
  getFirstAvailableBlock: A(),
  minimumLedgerSlot: A(),
  getGenesisHash: A(),
  getHealth: A(),
  getVersion: A(),
  getIdentity: A(),
  getEpochSchedule: A(),
  getInflationRate: A(),
  getInflationReward: A({ configIndex: 1, weight: 2 }),
  getHighestSnapshotSlot: A(),
  getMaxRetransmitSlot: A(),
  getMaxShredInsertSlot: A(),
  getRecentPerformanceSamples: A(),
  getRecentPrioritizationFees: A(),
  getSlotLeaders: A(),
  getLeaderSchedule: A({ weight: 5 }),
  getClusterNodes: A({ weight: 5 }),
  getVoteAccounts: A({ configIndex: 0, weight: 5 }),
  getSupply: A({ configIndex: 0, contextResponse: true, weight: 5 }),

  // ---- Class B: needs Helius (indexes, DAS, methods public nodes disable) ----
  getProgramAccounts: B(10, { creditsVerified: true, configIndex: 1, minContextSlot: true }),
  getProgramAccountsV2: B(1, { creditsVerified: true, note: "Helius paginated getProgramAccounts" }),
  getTokenAccountsByOwner: B(1, { configIndex: 2, minContextSlot: true, contextResponse: true }),
  getTokenAccountsByOwnerV2: B(1, { note: "Helius paginated variant" }),
  getTokenAccountsByDelegate: B(1, { configIndex: 2, minContextSlot: true, contextResponse: true }),
  getTokenLargestAccounts: B(1, { configIndex: 1, contextResponse: true }),
  getLargestAccounts: B(1, { configIndex: 0, contextResponse: true }),
  getSignaturesForAddress: B(10, { configIndex: 1, minContextSlot: true, note: "history index" }),
  getTransactionsForAddress: B(10, { note: "Helius history API" }),
  getPriorityFeeEstimate: B(1, { creditsVerified: true, note: "Helius Priority Fee API" }),
  // DAS (Digital Asset Standard), all 10 credits on Helius.
  getAsset: B(10, { creditsVerified: true }),
  getAssetBatch: B(10, { creditsVerified: true }),
  getAssetProof: B(10, { creditsVerified: true }),
  getAssetProofBatch: B(10, { creditsVerified: true }),
  getAssetsByOwner: B(10, { creditsVerified: true }),
  getAssetsByAuthority: B(10, { creditsVerified: true }),
  getAssetsByCreator: B(10, { creditsVerified: true }),
  getAssetsByGroup: B(10, { creditsVerified: true }),
  searchAssets: B(10, { creditsVerified: true }),
  getSignaturesForAsset: B(10, { creditsVerified: true }),
  getTokenAccounts: B(10, { creditsVerified: true }),
  getNftEditions: B(10, { creditsVerified: true }),

  // ---- Class C: transaction landing and freshness-sensitive simulation ----
  sendTransaction: { cls: "C", credits: 1, creditsVerified: true, note: "fast tier only; staked path" },
  simulateTransaction: { cls: "C", credits: 1, creditsVerified: true, configIndex: 1 },

  // ---- Class D: never forwarded ----
  requestAirdrop: { cls: "D", note: "faucet; not available through the gateway" },
};

export const METHODS: ReadonlyMap<string, MethodSpec> = new Map(
  Object.entries(DEFS).map(([name, d]) => [
    name,
    {
      name,
      cls: d.cls,
      credits: d.credits ?? (d.cls === "D" ? 0 : 1),
      creditsVerified: d.creditsVerified ?? d.cls === "A",
      weight: d.weight ?? 1,
      configIndex: d.configIndex,
      injectCommitment: d.injectCommitment,
      minContextSlot: d.minContextSlot,
      contextResponse: d.contextResponse,
      cacheableWhenFinalized: d.cacheableWhenFinalized,
      note: d.note,
    } satisfies MethodSpec,
  ]),
);

export function getMethod(name: string): MethodSpec | undefined {
  return METHODS.get(name);
}

/** Methods whose names end in Subscribe/Unsubscribe are WebSocket-only. */
export function isSubscriptionMethod(name: string): boolean {
  return /(Subscribe|Unsubscribe)$/.test(name);
}
