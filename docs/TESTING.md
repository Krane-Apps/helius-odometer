# Testing

| Command | What it runs | Needs |
|---|---|---|
| `npm run typecheck` | `tsc --noEmit` over source, tests and scripts | Node 22.13+ |
| `npm test` | Unit and integration tests | Node 22.13+ |
| `npm run test:e2e` | End-to-end suite on a local validator | `solana-test-validator` on PATH, or Docker |
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
9. Credited top-ups equal the USDC the operator received on-chain, and the ledger reconciles.

## CI

`.github/workflows/ci.yml` runs typecheck, unit and integration tests and the build. A second job installs Agave and runs the end-to-end suite. The e2e suite skips itself when no validator can be started, so check the job log shows `9 passed`.
