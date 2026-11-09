# Architecture

Helius Odometer is a single Node.js process (Hono on `@hono/node-server`) with a SQLite ledger. This document follows one request through the system and then covers each subsystem's rules.

## Request lifecycle

`POST /v1/rpc/{tier}` goes through these steps (`src/rpc/handler.ts`, `src/rpc/metered.ts`):

1. **Parse and validate.** Body limit, JSON-RPC 2.0 validation, batch size (`MAX_BATCH`). Invalid batch items become per-item errors.
2. **Quote.** Each method is looked up in the catalog (`src/pricing/methods.ts`) and priced for the tier. Unknown, blocked, WebSocket-only and tier-ineligible methods are rejected here, without asking for payment.
3. **Max-price guard.** `X-Odometer-Max-Price` refuses a request whose total exceeds what the caller expects (409, not charged).
4. **Authorize** (`src/payments/paywall.ts`):
   - a `PAYMENT-SIGNATURE` header settles a top-up first, then the call is served;
   - otherwise a session token (`Authorization: Bearer`) or a SIWx proof (`SIGN-IN-WITH-X`) identifies the wallet;
   - a wallet with enough available balance is served; anything else gets a 402 challenge, rate-limited per client IP.
5. **Per-wallet rate limit.** One token per call, so a batch costs its size.
6. **Idempotency.** An `Idempotency-Key` replays the stored response without charging; a different body under the same key gets 422.
7. **Reserve** the quoted total. A concurrent spend that drained the balance turns into a fresh 402; a daily cap breach is a 429.
8. **Route** each call (`src/routing/router.ts`), up to 8 batch items concurrently.
9. **Finalize**: debit the sum of billable calls, release the rest of the reservation.
10. **Respond** with the JSON-RPC result plus diagnostic, balance, session and settlement headers.

## Payments

### Model: prepaid balance

The 402 lists one x402 `exact` requirement per top-up denomination (`TOPUP_OPTIONS_USD`, default $1, $5, $20), smallest first, so a stock client pays the smallest. Each requirement sets `extra.paymentFlow: "upfront"`, which makes the x402 SDK settle **before** the handler runs. The call is only served after the money has moved.

Requirements also carry a cached recent blockhash (`extra.recentBlockhash`), so clients skip a round trip. Clients without their own RPC can use `POST /v1/bootstrap`, a free endpoint that serves only `getLatestBlockhash` and the payment mint's account, rate-limited per IP.

### Crediting exactly once

Settlement hooks on the x402 resource server (`src/payments/x402.ts`) drive the ledger:

| Hook | Action |
|---|---|
| `onBeforeSettle` | Record the attempt keyed by the SHA-256 of the signed payload. A payload that already settled is refused (replay); one in flight is refused (race). |
| `onAfterSettle` | Check payTo and asset match the configuration, then credit the payer once. Idempotent on both the payload hash and the transaction signature. |
| `onSettleFailure` | Mark the attempt failed so the same signed payload may be retried. |

If crediting fails after money moved, the hook throws `AfterSettleAbortError`. The settlement is reported as failed to the client with its transaction signature, the top-up is flagged `needs_review`, and a structured log line records it for recovery. Top-ups stuck in `settling` for 10 minutes are flagged by reconciliation.

### Identity: SIWx and sessions

- **SIWx** (`src/payments/siwx.ts`): Sign-In-With-Solana proofs per the x402 `sign-in-with-x` extension. The domain and URI must match the configured `PUBLIC_ORIGIN`, never request headers. Signatures are ed25519. `issuedAt` must be within 5 minutes. Every nonce is single-use, stored in SQLite.
- **Sessions** (`src/payments/session.ts`): after a SIWx proof or a top-up, the gateway issues an HMAC-signed token (`odo1.<claims>.<sig>`, default 30 minutes). It carries the wallet and a per-wallet epoch; `POST /v1/session/revoke` bumps the epoch and invalidates all of that wallet's tokens. Sessions turn the x402 two-round-trip pattern into one round trip per call.

### MCP

- **Local** (`src/mcp/main.ts`): an stdio MCP server wrapping `OdometerClient`. The key and spend limits live in the agent's process.
- **Remote** (`src/mcp/remote.ts`): streamable-HTTP MCP at `/mcp`. A tool call without balance returns an x402 `PaymentRequired` tool result for a top-up. When the client retries with `_meta["x402/payment"]`, the top-up settles through the same hooks, the payer is bound to that MCP session, and later calls in the session spend the balance. The x402 MCP transport has no sign-in mechanism, so a new session pays again; the money lands in the same refundable balance.

## Routing

### Method classes

| Class | Meaning | Examples |
|---|---|---|
| A | Public-eligible reads | `getBalance`, `getAccountInfo`, `getLatestBlockhash`, `getTransaction` |
| B | Helius-only for availability | DAS, `getProgramAccounts(V2)`, `getTokenAccountsByOwner`, `getSignaturesForAddress`, `getPriorityFeeEstimate` |
| C | Helius-only for landing | `sendTransaction` (fast only), `simulateTransaction` |
| D | Blocked | `requestAirdrop` |

Anything not in the catalog is refused with `-32601`, so the gateway is never an open proxy.

### Tier policies

| Plan | Behavior |
|---|---|
| `public-only` (economy, class A) | Up to `MAX_PUBLIC_ATTEMPTS` public upstreams. May queue up to 1.5 s for a rate-limit token. Never escalates; exhaustion returns `-32061`, not charged. |
| `public-first` (standard, class A) | Public attempts with a short timeout (`PUBLIC_ATTEMPT_TIMEOUT_MS`), then Helius on 429, timeout, lag, unhealthy-node or unsupported-method errors. |
| `helius` (fast, and every class B/C call) | Helius, retried once on infrastructure errors. Waits up to 500 ms for a rate-limit token, then 429. |
| `sendTransaction` | Helius or Sender (`X-Odometer-Send-Via: sender`), exactly one attempt, never mirrored. A timeout returns `-32063` (outcome unknown, not charged). |

### Upstream health

`src/routing/pool.ts` and `src/routing/upstream.ts`:

- Public upstreams are probed with `getSlot` at `confirmed` every `HEALTH_POLL_MS`. Helius is probed every `HELIUS_HEALTH_POLL_MS` (default 30 s, to save credits) and observed passively from responses.
- **Lag:** an upstream more than `MAX_SLOT_LAG` slots behind the best fresh observation is skipped. Only `confirmed` observations are compared.
- **429:** the upstream cools for `Retry-After` (default 10 s).
- **Ejection:** 3 consecutive failures eject an upstream with exponential backoff (5 s to 60 s). Two successful probes readmit it.
- **Rate limits:** a token bucket per upstream, plus Helius group buckets for `sendTransaction` and heavy methods (DAS and program scans).
- **Learning:** a public provider that answers `-32601` for a method stops receiving it.
- **Selection:** power of two choices on latency (EWMA), weighted.

### Consistency safeguards

`src/routing/consistency.ts`:

- **Commitment normalization.** When the caller set none, economy and standard inject `confirmed` (configurable per tier) for state reads. `getTransaction` and `getBlock` keep the Solana default of `finalized`, which keeps them cacheable.
- **Monotonic reads.** The gateway keeps a high-water mark of `context.slot` per wallet and per commitment. On multi-upstream tiers it injects `minContextSlot = mark - MIN_CONTEXT_SLOT_MARGIN` (default 4), so a wallet never reads older state than it already saw. Marks expire after 30 s. An upstream answering `-32016` is retried elsewhere.
- **Preflight.** `sendTransaction` defaults `preflightCommitment` to `confirmed` when the caller set none and did not skip preflight. Solana's default of `finalized` rejects blockhashes fetched at `confirmed`, which is exactly what the gateway normalizes `getLatestBlockhash` to.
- **Sticky transaction follow-ups.** For 90 s after a wallet sends a transaction, its standard-tier `getSignatureStatuses`, `getLatestBlockhash`, `getBlockHeight`, `isBlockhashValid` and `getTransaction` go to Helius, the upstream that saw the transaction.
- **Finalized cache.** `getTransaction` and `getBlock` at `finalized` with non-null results are cached (LRU, 64 MB).
- **Explicit caller values always win.** Every injection is reported in `X-Odometer-Commitment-Injected` and `X-Odometer-Min-Context-Slot`.

### Optional rebroadcast

With `X-Odometer-Rebroadcast: true`, a landed `sendTransaction` is re-sent (same bytes, same upstream, `skipPreflight`) every 2 s until it confirms, its blockhash expires, or `REBROADCAST_MAX_SECONDS` passes. Re-sending identical bytes is idempotent on-chain.

## Ledger

`src/ledger/ledger.ts`, SQLite in WAL mode via `node:sqlite`.

- Amounts are integer micros (1e-6 USD), exactly one atomic unit of USDC.
- `accounts.balance` includes reserved funds; `available = balance - reserved`. Constraints keep both non-negative and `reserved <= balance`.
- Every balance change writes an append-only `journal` row with a unique `(kind, ref)` receipt: `topup`, `debit`, `refund`, `refund_reversal`, `adjustment`. Replays cannot double-credit or double-debit.
- Reconciliation, run every 60 s and on demand via `POST /admin/reconcile`, checks:
  - every balance equals the sum of its journal;
  - every reserved amount equals its open reservations;
  - stale reservations (over 2 minutes, or anything left by a previous process at startup) are released;
  - stuck settlements are flagged.
- Refund requests move funds out of the available balance immediately. Rejecting a request re-credits them; marking it paid records the payout transaction.

## Billing verdicts

| Upstream outcome | Billed? | Retried? |
|---|---|---|
| `result` | yes | no |
| Client error (`-32600`, `-32602`, `-32002` preflight failure, `-32003`, `-32007`, `-32009`, ...) | yes | no |
| Infrastructure error (`-32005`, `-32016`, `-32004`, `-32603`, `-32601` from a provider, ...) | no | yes, elsewhere |
| HTTP 429 / 5xx, timeout, network error, malformed response | no | yes, elsewhere |
| Every candidate exhausted | no | returns `-32060`/`-32061`/`-32062`/`-32064` |

The gateway's own errors use codes `-32050` to `-32064` and say "not charged" when nothing was debited.

Two consequences of this contract are easy to misread:

- A charged `sendTransaction` means the RPC accepted the transaction. It does not mean the transaction landed or succeeded, and the gateway does not price or guarantee inclusion.
- The balance is debited only the per-call price. Your transactions pay their own Solana fees, priority fees and tips. Top-up settlement fees are paid by the facilitator's fee payer, and any facilitator fee is the operator's cost.

## Security model

- The gateway never holds client keys. Clients sign their own payment transactions and SIWx messages.
- A session token or a remote MCP session id is a bearer credential that can spend one wallet's prepaid balance until it expires. Serve only over TLS. Per-wallet daily caps (`WALLET_DAILY_CAP_USD`, lowerable per wallet) bound the damage of a leaked token.
- Payment requirements are built server-side, and settled requirements are re-checked against the configured payTo and asset before crediting.
- The admin API uses a constant-time token comparison and is disabled unless `ADMIN_TOKEN` is set.
- Upstream URLs, which may contain API keys, never appear in logs, `/status` or benchmark reports.

## Limits of this version

- **Single process.** SQLite and in-memory caches (sessions, rate limits, high-water marks, MCP sessions) assume one instance. Horizontal scale needs a shared ledger such as Postgres, and shared rate limits.
- **No WebSocket subscriptions.** HTTP JSON-RPC only.
- **Prices assume a 6-decimal stablecoin.**
- **Batch-settlement payment channels** (x402 `batch-settlement` scheme) are the natural next payment option once Solana facilitator support is verified in production. They would replace top-ups with per-call vouchers and periodic on-chain claims.
