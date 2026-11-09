import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from "@x402/core/types";

export const FAKE_FEE_PAYER = "FeePayer11111111111111111111111111111111111";

/**
 * In-memory facilitator for fast integration tests. A "payment" is a payload
 * `{ transaction: "fake:<wallet>:<nonce>" }`; settling it succeeds once and
 * reports `<wallet>` as payer, like the real SVM exact facilitator.
 */
export class FakeFacilitator implements FacilitatorClient {
  readonly settled = new Map<string, string>();
  settleCalls = 0;
  failNextSettle?: string;
  /** Next settle fails but reports a broadcast transaction (outcome unknown). */
  failNextSettleWithTransaction?: { reason: string; transaction: string };
  /** Next settle throws this error (e.g. a FacilitatorTimeoutError). */
  throwOnNextSettle?: Error;

  constructor(private readonly network: string) {}

  async getSupported(): Promise<SupportedResponse> {
    return {
      kinds: [{ x402Version: 2, scheme: "exact", network: this.network as `${string}:${string}`, extra: { feePayer: FAKE_FEE_PAYER, transactionVersions: [0] } }],
      extensions: [],
      signers: { "solana:*": [FAKE_FEE_PAYER] },
    };
  }

  async verify(payload: PaymentPayload, _req: PaymentRequirements): Promise<VerifyResponse> {
    const wallet = parse(payload);
    return wallet ? { isValid: true, payer: wallet.wallet } : { isValid: false, invalidReason: "invalid_payload" };
  }

  async settle(payload: PaymentPayload, req: PaymentRequirements): Promise<SettleResponse> {
    this.settleCalls += 1;
    const parsed = parse(payload);
    if (!parsed) return { success: false, errorReason: "invalid_payload", transaction: "", network: req.network };
    if (this.throwOnNextSettle) {
      const err = this.throwOnNextSettle;
      this.throwOnNextSettle = undefined;
      throw err;
    }
    if (this.failNextSettleWithTransaction) {
      const f = this.failNextSettleWithTransaction;
      this.failNextSettleWithTransaction = undefined;
      return { success: false, errorReason: f.reason, transaction: f.transaction, network: req.network, payer: parsed.wallet };
    }
    if (this.failNextSettle) {
      const reason = this.failNextSettle;
      this.failNextSettle = undefined;
      return { success: false, errorReason: reason, transaction: "", network: req.network, payer: parsed.wallet };
    }
    const key = String(payload.payload.transaction);
    if (this.settled.has(key)) {
      return { success: false, errorReason: "duplicate_settlement", transaction: "", network: req.network, payer: parsed.wallet };
    }
    const signature = `sig${parsed.nonce}${"1".repeat(Math.max(0, 80 - parsed.nonce.length))}`.slice(0, 88);
    this.settled.set(key, signature);
    return { success: true, transaction: signature, network: req.network, payer: parsed.wallet, amount: req.amount };
  }
}

function parse(payload: PaymentPayload): { wallet: string; nonce: string } | undefined {
  const tx = payload.payload?.transaction;
  if (typeof tx !== "string" || !tx.startsWith("fake:")) return undefined;
  const [, wallet, nonce] = tx.split(":");
  return wallet && nonce ? { wallet, nonce } : undefined;
}
