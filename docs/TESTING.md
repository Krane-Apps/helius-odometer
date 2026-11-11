# Testing

| Command | What it runs | Needs |
|---|---|---|
| `npm run typecheck` | `tsc --noEmit` over source, tests and scripts | Node 22.13+ |
| `npm test` | Unit and integration tests | Node 22.13+ |
| `npm run test:e2e` | End-to-end suite on a local validator | `solana-test-validator` on PATH, or Docker |
| `npm run test:audit` | Both reviews' reproduction scripts (2026-11-09 and 2026-11-11), as regression checks | `npm run build` first |
| `npm run test:all` | All of the above | both |
| `npm run localnet -- --demo` | Interactive local environment plus a scripted agent session | `solana-test-validator` or Docker |

## Unit and integration

- `test/unit/ledger.test.ts`: top-ups credited once (payload and signature replays), reserve and finalize, partial charges, releases, daily caps, refunds, adjustments, reconciliation (including detecting tampering), idempotency keys, nonces.
- `test/unit/pricing.test.ts`: tier prices, Helius-backed prices, `sendTransaction` rules, rejections, batch quotes, overrides, catalog consistency.
- `test/unit/router.test.ts` and `router-send.test.ts`: economy never escalates, standard escalation on 429 and timeouts, second public attempt, lag skipping, Helius-only methods, client errors billed but not retried, learning unsupported methods, ejection and readmission, commitment and `minContextSlot` injection, retry on `-32016`, the finalized cache, `sendTransaction` single attempt, sticky follow-ups, Helius rate limits, Sender routing, preflight commitment defaults.
- `test/unit/consistency.test.ts`: parameter normalization edge cases, per-commitment high-water marks, wire-transaction decoding, JSON-RPC validation.
- `test/unit/bench.test.ts`: benchmark statistics, slot lag, key redaction.
- `test/integration/gateway.test.ts`: the real HTTP app against mock upstreams and a fake facilitator. Covers the 402 challenge format, settling and serving, sessions, payment replay, SIWx (including nonce reuse and a cross-origin proof), insufficient balance, batches, max price, idempotency, unbilled failures with standard escalation, top-ups, refunds, the admin API, settlement failure recovery, session revocation and the bootstrap endpoint.
- `test/integration/limits.test.ts`: Bazaar metadata off by default, per-IP challenge limits, per-call batch rate limits.
- `test/unit/daily-cap.test.ts` and `test/integration/caps.test.ts`: a wallet cap of zero stops spending, a wallet cap never lifts the operator ceiling, pending reservations count, and the public cap endpoint.
- `test/unit/client-budget.test.ts`: concurrent top-ups stay within `maxSpendUsd`, a lost response keeps its payment counted, a failed signature returns the budget, and the count can persist.
- `test/integration/remote-mcp.test.ts`: remote MCP stops spending on revocation, expiry and an IP change; a session spends only what it paid; max price and idempotency over MCP; session creation limits.
- `test/unit/topup-recovery.test.ts` and `test/integration/topup-recovery.test.ts`: ambiguous settlements are frozen and never re-settled, operator resolution credits the original receipt once with matching on-chain evidence, late completions and replays credit nothing, and a payment settling after rejection returns to review.
- `test/integration/billing.test.ts`: `/pricing` lists exactly the error codes the router bills and keeps `sendTransaction` acceptance and fees separate, and no public surface claims every failed call is free.
- `test/unit/crash-recovery.test.ts`: on a file-backed ledger, a request interrupted mid-flight is released and runs again uncharged; a charge and its replay receipt survive a restart together; an injected receipt failure rolls back the debit; a settlement in progress at a crash becomes unresolved; a pending refund stays owed; backup and restore; the writer lock refuses a second process and hands over only after a stale heartbeat.
- `test/integration/review-followup.test.ts`: a Helius 401 or 403 on a REST route is not charged and does not leak upstream text; a paid response is replayed with an empty balance over HTTP and MCP; a wallet with spending stopped or its cap used up is refused without a deposit prompt.
- `test/unit/router-send.test.ts` also pins the rebroadcast route: resends go to the upstream that accepted the transaction, status reads to Helius RPC, and resending stops on confirmation.
- `test/unit/alerts.test.ts`: alert payloads, auth header, deduplication, and webhook failures that never throw.
- `test/integration/operations.test.ts`: receipts by request id and idempotency key, readiness (including custody short of liabilities, a missing token account, funds outside the associated token account, and an unresolved settlement), a second process refused on the same ledger, and a critical alert delivered to a webhook.

## End to end

`test/e2e/x402-localnet.test.ts` starts `solana-test-validator`, creates a 6-decimal SPL mint standing in for USDC, funds wallets, and runs the official x402 SVM facilitator code (`src/facilitator/server.ts`), the gateway, and agents. Helius is played by `dev/helius-proxy.ts`, which forwards to the same validator and answers DAS calls. Everything else is real: payments are signed SPL transfers that land on-chain.

It verifies:

1. The first call pays a USDC top-up on-chain (agent -1, operator +1) and is served.
2. Later calls are debited from the balance with no new on-chain payment.
3. Real chain data through each tier, with honest routing headers.
4. `sendTransaction` lands on the fast tier, and follow-up status reads are pinned to Helius.
5. A stock x402 client (`@x402/fetch` with the SIWx extension) pays once, then reuses the balance.
6. A replayed `PAYMENT-SIGNATURE` is never credited twice.
7. An MCP agent drives the stdio bridge, pays from its own wallet and hits its local spend limit.
8. A stock x402 MCP client on remote `/mcp` pays once, then makes several calls for free.
9. An operator verifies a settled top-up against the chain, as recovery would.
10. Credited top-ups equal the USDC the operator received on-chain, the ledger reconciles, and readiness reads the operator's real token account and finds custody covering what agents are owed.

## Gateway overhead

`npm run loadtest` starts an instant mock upstream and the gateway in separate processes, then compares calling the upstream directly with going through the full metered path. That path covers the session check, rate limits, the ledger reserve and finalize on a WAL SQLite file, and routing.

Measured on 2026-11-09 in the 4-vCPU development container, Node 22.23. The figures are indicative, not a service promise.

| Concurrency | Direct p50 / p95 | Via gateway p50 / p95 | Added p50 / p95 | Gateway throughput |
|---:|---|---|---|---:|
| 1 | 0.70 / 1.11 ms | 2.54 / 4.64 ms | 1.85 / 3.53 ms | 356 req/s |
| 32 | 6.50 / 15.68 ms | 45.54 / 69.05 ms | queueing at capacity | 682 req/s |

One process sustains about 680 metered calls per second, more than the request limits of the Helius plans the plan considers. At low concurrency the gateway adds about 2 ms, small next to typical upstream latency. Every run debits exactly one charge per call and reconciles.

A CPU profile (`LOADTEST_PROFILE_DIR=<dir> npm run loadtest`) puts about a third of the time in SQLite commits: each call writes two transactions, a reservation and a finalize. Keeping reservations in memory would roughly halve that if more throughput is ever needed. A crash releases reservations anyway.

## CI

`.github/workflows/ci.yml` runs typecheck, unit and integration tests, the build and the audit regression scripts. A second job installs Agave and runs the end-to-end suite with `E2E_REQUIRE_VALIDATOR=1`: a missing validator fails the job instead of skipping it, and the verbose reporter lists all 10 tests. Locally, without that variable, the suite still skips when no validator can be started.
