import type { PaymentRequirements } from "@x402/core/types";
import { ExactSvmScheme } from "@x402/svm/exact/server";

export interface CachedBlockhash {
  blockhash: string;
  lastValidBlockHeight: string;
  fetchedAt: number;
}

/**
 * Keeps a recent blockhash warm so 402 challenges can embed one
 * (`extra.recentBlockhash`) without an RPC round trip per challenge.
 */
export class BlockhashCache {
  private current?: CachedBlockhash;
  private inflight?: Promise<void>;

  constructor(
    private readonly fetcher: () => Promise<{ blockhash: string; lastValidBlockHeight: string | number | bigint } | undefined>,
    private readonly maxAgeMs = 10_000,
    private readonly refreshAfterMs = 4_000,
  ) {}

  /** Returns a fresh-enough blockhash or undefined; refreshes in the background. */
  get(now = Date.now()): CachedBlockhash | undefined {
    const cur = this.current;
    if (!cur || now - cur.fetchedAt > this.refreshAfterMs) void this.refresh();
    if (cur && now - cur.fetchedAt <= this.maxAgeMs) return cur;
    return undefined;
  }

  refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const value = await this.fetcher();
        if (value?.blockhash) {
          this.current = {
            blockhash: value.blockhash,
            lastValidBlockHeight: value.lastValidBlockHeight.toString(),
            fetchedAt: Date.now(),
          };
        }
      } catch {
        // Clients fall back to fetching their own blockhash.
      } finally {
        this.inflight = undefined;
      }
    })();
    return this.inflight;
  }
}

/** Exact SVM server scheme that embeds a cached blockhash instead of fetching one per challenge. */
export class CachedBlockhashExactSvmScheme extends ExactSvmScheme {
  constructor(private readonly blockhashes?: BlockhashCache) {
    super();
  }

  override async enhancePaymentRequirements(
    paymentRequirements: PaymentRequirements,
    supportedKind: { x402Version: number; scheme: string; network: `${string}:${string}`; extra?: Record<string, unknown> },
    extensionKeys: string[],
  ): Promise<PaymentRequirements> {
    const enhanced = await super.enhancePaymentRequirements(paymentRequirements, supportedKind, extensionKeys);
    const bh = this.blockhashes?.get();
    if (!bh) return enhanced;
    return {
      ...enhanced,
      extra: { ...enhanced.extra, recentBlockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight },
    };
  }
}
