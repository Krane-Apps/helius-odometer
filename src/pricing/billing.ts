import { CLIENT_RPC_CODES } from "../routing/jsonrpc.js";

/**
 * The billing contract, in one place so every surface (pricing, llms.txt,
 * MCP descriptions, docs) states the same thing.
 */
export const BILLING_CONTRACT = {
  notCharged:
    "Gateway and upstream delivery failures: timeouts, rate limits, unhealthy or lagging nodes, exhausted pools and gateway errors.",
  charged:
    "Valid RPC answers, including errors caused by the request itself: invalid request or params, failed preflight simulation, signature verification failure and the other codes in billedErrorCodes.",
  sendTransaction:
    "A charged sendTransaction means the RPC accepted the transaction. It does not mean the transaction landed or succeeded; check getSignatureStatuses.",
  separateCosts:
    "The per-call price is the only thing debited from the balance. Solana transaction fees, priority fees and tips are paid by your own transactions. Top-up settlement network fees are paid by the facilitator's fee payer and any facilitator fee is the operator's cost: a top-up credits exactly the amount you paid.",
} as const;

export const BILLED_ERROR_CODES: readonly number[] = [...CLIENT_RPC_CODES].sort((a, b) => b - a);

export const BILLING_SUMMARY =
  "Gateway and upstream delivery failures are not charged. Valid RPC answers are, including errors your request causes (invalid params, failed preflight, bad signatures). A charged sendTransaction means accepted by the RPC, not landed.";
