/**
 * Classifies a failed x402 settlement. The distinction matters for money:
 *  - "failed": the payment definitely did not move funds, so the same signed
 *    payload may be retried;
 *  - "ambiguous": funds may have moved (a timeout, a pending settlement, or a
 *    transaction that was broadcast but not confirmed). The top-up is frozen
 *    for operator review and is credited only once, if it landed.
 */
export type SettleOutcome =
  | { kind: "failed"; reason: string }
  | { kind: "ambiguous"; reason: string; txSignature?: string; payer?: string };

/** Reasons that prove nothing settled. */
const DEFINITIVE = /^(invalid_|insufficient_|unsupported_|missing_|transaction_failed|transaction_simulation_failed|simulation_failed|expired)/i;
const AMBIGUOUS = /(pending|timeout|timed out|unexpected|unknown|confirmation)/i;
/** Network errors that mean the request never reached the facilitator. */
const NOT_SENT = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ERR_INVALID_URL"]);

export function classifySettleFailure(error: unknown): SettleOutcome {
  const err = error as { name?: string; message?: string; errorReason?: string; transaction?: string; payer?: string; cause?: { code?: string } } | undefined;
  const reason = err?.errorReason || err?.message || "settlement failed";
  if (err?.name === "SettleError") {
    if (err.errorReason && DEFINITIVE.test(err.errorReason)) return { kind: "failed", reason };
    if (err.transaction) return { kind: "ambiguous", reason: `broadcast but not confirmed: ${reason}`, txSignature: err.transaction, payer: err.payer };
    if (AMBIGUOUS.test(reason)) return { kind: "ambiguous", reason, payer: err.payer };
    return { kind: "failed", reason };
  }
  if (err?.name === "FacilitatorTimeoutError") return { kind: "ambiguous", reason };
  const code = err?.cause?.code;
  if (code && NOT_SENT.has(code)) return { kind: "failed", reason: `facilitator unreachable (${code})` };
  // Anything else (resets, unexpected exceptions) leaves the outcome unknown.
  return { kind: "ambiguous", reason };
}
