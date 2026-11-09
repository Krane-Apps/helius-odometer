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
| `onSettleFailure` | Classify the failure (`src/payments/settle-outcome.ts`). A definitive failure (invalid payload, insufficient funds, a request that never left) marks the attempt failed, so the same signed payload may be retried. An ambiguous one (timeout, `settlement_pending`, a broadcast transaction that did not confirm) marks it `needs_review` with any transaction signature and payer, freezes it, and raises an alert. |

A frozen payment is not settled again: resending it answers 402 `payment_under_review`, and the client gets 502 `settlement_unknown` rather than a definitive failure. An operator resolves it once, against the original receipt and with on-chain evidence (`POST /admin/topups/{id}/resolve`). A payment that settles after an operator rejected it goes back to review instead of crediting.

If crediting fails after money moved, the hook throws `AfterSettleAbortError`. The settlement is reported as failed to the client with its transaction signature, the top-up is flagged `needs_review`, and a critical alert fires. Top-ups stuck in `settling` for 10 minutes count as unresolved in reconciliation.

### Identity: SIWx and sessions

- **SIWx** (`src/payments/siwx.ts`): Sign-In-With-Solana proofs per the x402 `sign-in-with-x` extension. The domain and URI must match the configured `PUBLIC_ORIGIN`, never request headers. Signatures are ed25519. `issuedAt` must be within 5 minutes. Every nonce is single-use, stored in SQLite.
- **Sessions** (`src/payments/session.ts`): after a SIWx proof or a top-up, the gateway issues an HMAC-signed token (`odo1.<claims>.<sig>`, default 30 minutes). It carries the wallet and a per-wallet epoch; `POST /v1/session/revoke` bumps the epoch and invalidates all of that wallet's tokens. Sessions turn the x402 two-round-trip pattern into one round trip per call.

### MCP

- **Local** (`src/mcp/main.ts`): an stdio MCP server wrapping `OdometerClient`. The key and spend limits live in the agent's process.
- **Remote** (`src/mcp/remote.ts`): streamable-HTTP MCP at `/mcp`. A tool call without balance returns an x402 `PaymentRequired` tool result for a top-up. When the client retries with `_meta["x402/payment"]`, the top-up settles through the same hooks and the payer is bound to that MCP session. The x402 MCP transport has no sign-in mechanism, so a new session pays again; the money lands in the same refundable balance.

  An MCP session id is not a wallet credential. The binding lets a session spend at most what it paid (its voucher), and every paid call re-checks it: the wallet's session epoch must be unchanged (revoking the wallet ends every session at once), the binding must be within its absolute lifetime (`REMOTE_MCP_SESSION_TTL_SECONDS`), and with `REMOTE_MCP_BIND_IP` the call must come from the IP that paid. A client that sends `Authorization: Bearer <session token>` spends the wallet's full balance under the token's own checks. Session creation is rate-limited per IP and capped in total. Tool calls accept the same `maxPriceUsd` and `idempotencyKey` controls as HTTP.

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

- **Commitment normalization.** When the caller set none, every tier injects `confirmed` for state reads (configurable per tier with `ECONOMY_COMMITMENT`, `STANDARD_COMMITMENT`, `FAST_COMMITMENT`), so the same request means the same data on every tier. `getTransaction` and `getBlock` keep the Solana default of `finalized`, which keeps them cacheable. Benchmarks pin `confirmed` on every workload for the same reason.
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
- **Charge and receipt together.** The debit and the request's replay receipt (for an `Idempotency-Key`) are written in one transaction. A crash leaves both or neither: a charged request always replays its stored answer, and an uncharged one runs again. `GET /v1/receipts` answers "was this charged?" by request id or idempotency key, within the retention windows (`IDEMPOTENCY_RETENTION_HOURS`, `RESERVATION_RETENTION_DAYS`).
- **Restart recovery.** At startup every open reservation is released uncharged (whatever its timestamp) and every in-flight idempotency key is marked aborted, so a retry runs again instead of waiting forever.
- **One writer.** SQLite plus in-memory sessions, rate limits and reservations assume one process. A heartbeated lock row refuses a second gateway on the same database, and a process that loses the lock exits.
- **Manual credits** (`adjust`) are refused while a top-up that could credit the wallet is settling or under review: recovering a payment that way would let its receipt be credited again later.
- Reconciliation, run every 60 s and on demand via `POST /admin/reconcile`, checks:
  - every balance equals the sum of its journal;
  - every reserved amount equals its open reservations;
  - stale reservations (over 2 minutes) are released;
  - top-ups with an unknown outcome are counted, with their amount, as unresolved.

  It reports `arithmeticOk`, `unresolvedTopups`, `pendingRefunds` and `liabilitiesMicros` (balances plus pending refunds). `ok` is true only when the arithmetic holds and nothing is unresolved. This is a local check: it does not read the chain. `GET /admin/readiness` adds the on-chain side (custody against liabilities) and the other launch gates.
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
- A session token is a bearer credential that can spend one wallet's prepaid balance until it expires or the wallet revokes it. A remote MCP session id can spend only what that session paid, from the IP that paid, until its absolute expiry or a revocation. Serve only over TLS. The operator's daily ceiling (`WALLET_DAILY_CAP_USD`) bounds every wallet; a wallet can lower its own cap or set `0` to stop spending, but never lift the ceiling.
- The TypeScript client counts every signed top-up against `maxSpendUsd` before signing, one top-up at a time, and keeps a payment counted even if its response is lost. The count lives in memory: pass `initialSpentMicros` and `onSpendChange` to make it durable (the MCP bridge does this with `ODOMETER_SPEND_FILE`).
- Payment requirements are built server-side, and settled requirements are re-checked against the configured payTo and asset before crediting.
- The admin API uses a constant-time token comparison and is disabled unless `ADMIN_TOKEN` is set.
- Upstream URLs, which may contain API keys, never appear in logs, `/status` or benchmark reports.

## Limits of this version

- **Single process.** SQLite and in-memory caches (sessions, rate limits, high-water marks, MCP sessions) assume one instance, and the writer lock enforces it. Horizontal scale needs a shared ledger such as Postgres, and shared rate limits.
- **No WebSocket subscriptions.** HTTP JSON-RPC only.
- **Prices assume a 6-decimal stablecoin.**
- **Batch-settlement payment channels** (x402 `batch-settlement` scheme) are the natural next payment option once Solana facilitator support is verified in production. They would replace top-ups with per-call vouchers and periodic on-chain claims.
