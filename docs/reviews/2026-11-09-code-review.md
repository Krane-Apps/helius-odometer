# Helius Odometer: code-review handoff

Reviewed 9 November 2026. Snapshot: `c244b5323c4b7d4e28519052ee7cb9cf0c86b96b` on `main`.

**Verdict: a working prototype, not ready for customer deposits or production.** Fix the controls/recovery issues, then obtain upstream permission and run an approved live pilot. Do not add features first.

## Evidence and limits

- Independently ran `npm ci --ignore-scripts`, `npm run typecheck`, `npm test`, `npm run build`: all passed; 75 existing tests, Node 22.23.4.
- Latest GitHub Actions run shows both jobs successful: https://github.com/Krane-Apps/helius-odometer/actions/runs/42620918297 . The expanded e2e step did not expose its log body, so I could not independently confirm the claimed exact `9 passed` count. The suite skips when the validator is absent. CI should make that a failure.
- Source review confirms e2e creates a 6-decimal local SPL test mint and simulates Helius against the same local validator. These are real local-chain SPL transfers, not mainnet USDC or production Helius evidence. No local e2e rerun was done in this review because no validator was installed.
- Reproductions below use in-memory SQLite, mocked signing and local HTTP. No funds moved; no deployment, outreach or remote repository mutation.
- This is a focused code review, not a formal security audit or proof of absence of other bugs.

## P1: fix before deposits

### 1. Zero disables the operator daily ceiling

Source: `src/ledger/ledger.ts:136-140,277-289`; `src/api/public.ts:192-205`.
https://github.com/Krane-Apps/helius-odometer/blob/main/src/ledger/ledger.ts
https://github.com/Krane-Apps/helius-odometer/blob/main/src/api/public.ts

`effectiveDailyCap` returns `min(walletCap, operatorDefault)`. With walletCap=0 this becomes zero; `reserve` only checks `cap > 0`. An authenticated wallet may set this value through the public cap endpoint. Reproduced: $2 reserve rejected under $1 default, then accepted after wallet cap is set to zero.

This bypasses a daily policy ceiling, not the prepaid available-balance check. It cannot spend money that is not in the account. It matters for operator risk controls and users expecting zero to stop spending.

Fix: separate unlimited from zero, preserve the operator ceiling, and test the public endpoint plus pending reservations. Define whether a wallet zero means no spend or removal of its own cap. Neither meaning should erase a nonzero operator ceiling.

### 2. Concurrent top-up signing exceeds the client total budget

Source: `src/client/index.ts:261-282`.
https://github.com/Krane-Apps/helius-odometer/blob/main/src/client/index.ts

The total-budget check happens before an awaited signing call; the counter is incremented afterward. Two concurrent calls both pass using the old total. Reproduced with mocked signing: `maxSpendUsd=1` accepts two $1 payment-creation calls and records $2.

This is the client's per-instance top-up authorization budget. It is distinct from daily RPC debits and operator gateway caps. The SDK's per-payment limit does not necessarily prevent two individually permitted payments. This review did not execute real transfers for this repro.

Fix: reserve budget before any await, serialize payment creation/single-flight top-ups, and keep pending/uncertain authorizations accounted for. Do not release a reservation merely because the response was lost. Document that restarting/recreating the client resets its in-memory lifetime counter, or make the intended long-lived limit durable.

### 3. Revocation does not revoke remote MCP spending

Source: `src/mcp/remote.ts:43-81,178-219`; HTTP revoke endpoint in `src/api/public.ts:208-212`.
https://github.com/Krane-Apps/helius-odometer/blob/main/src/mcp/remote.ts

After a top-up, the remote MCP session stores a wallet. Subsequent calls use that binding without checking the account's session epoch. Reproduced locally with fake payment: pay, revoke wallet epoch, call again successfully.

Prerequisite: an existing funded MCP session. This does not show wallet private-key theft. A retained/leaked session remains a spending credential despite revocation; continued activity can extend the idle timeout because no absolute expiry is enforced.

Fix: verify authenticated wallet+epoch on each paid call, bind/expire MCP sessions, and ensure revoke terminates them. Add parity for HTTP max-price/idempotency controls, session creation/IP limits and regression tests. MCP session ID alone should not authenticate spending. Related guidance: https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices .

### 4. Manual settlement recovery is not linked to the original receipt

Source: `src/ledger/ledger.ts` (`completeTopup`, `adjust`, `reconcile`) and `docs/OPERATIONS.md` (needs_review runbook).
https://github.com/Krane-Apps/helius-odometer/blob/main/docs/OPERATIONS.md

The runbook says to manually adjust the wallet if USDC moved but was not credited. This adjustment is not keyed to the top-up receipt, so later completion of that original receipt still adds its full amount. Reproduced: mark $1 payment needs_review, apply runbook-style $1 adjustment, later complete the same receipt; balance becomes $2.

This is an operator recovery/delayed-completion hazard, not a demonstrated unauthenticated remote exploit. It requires manual recovery plus later completion or callback. The exact production facilitator timing path was not exercised.

Fix: add an atomic operator recovery action that completes the original top-up once, keyed by payload and network/asset/signature evidence. Never resolve a payment with an unrelated adjustment and leave the original receipt eligible for credit. Test delayed callbacks and replays after manual resolution.

### 5. 'Failed calls are never charged' is false as written

Sources: `src/routing/jsonrpc.ts` (`CLIENT_RPC_CODES`) and `src/routing/router.ts` (`billable`).
https://github.com/Krane-Apps/helius-odometer/blob/main/src/routing/jsonrpc.ts
https://github.com/Krane-Apps/helius-odometer/blob/main/src/routing/router.ts

The router deliberately bills client-error answers, including invalid params (-32602), preflight simulation failure (-32002), and signature verification failure (-32003). Tests/docs acknowledge client errors are billed. A successful sendTransaction RPC response is charged even if the transaction later fails or never lands. Generic gateway outages and exhausted routing are normally unbilled.

Choose the contract: either change billing to exclude all RPC errors, or say 'gateway/upstream delivery failures are unbilled; valid RPC answers including specified client errors may be billed.' Keep RPC charge, USDC top-up settlement fee, Solana transaction fee, priority fee and tip separate. This gateway does not currently price successful inclusion.

## P2: crash and operational hardening

### Debit and replay receipt are separate commits

Source: `src/rpc/metered.ts:158-174`; ledger idempotency methods.
https://github.com/Krane-Apps/helius-odometer/blob/main/src/rpc/metered.ts

Final debit commits before idempotencyComplete and before the HTTP response is handed back. A crash can leave a charged request in_flight; keys are pruned after a day. No durable receipt-query flow proves delivery. This is a static-code finding, not an injected crash test in this audit.

Fix: write debit and durable replay outcome atomically; define retention, retrieval and unknown/reconciling states. Inject crashes after settlement, upstream acceptance, debit and receipt persistence. Returning a response object is not proof the client received it.

### Local ledger consistency is not on-chain reconciliation

`reconcile()` compares accounts/journal/reservations and flags stale top-ups. It does not query chain history, check operator custody balances, prove transfer finality or execute refunds. Reproduced `ok=true` with one top-up needing review. Also, `start()` unconditionally releases all old reservations, so do not run multiple workers against a shared DB without a single-writer/ownership design.

Treat unresolved settlements as a separate warning/alert and liability even if arithmetic checks pass. Give alerts an actual delivery path, not only logs. Add ambiguous timeout, late settlement, restart, refund and backup/restore tests. Refunds are operator-mediated payouts, not automated withdrawals.

## What is done and what remains

Implemented prototype: prepaid balance, SIWx/session auth, HTTP + TypeScript + local/remote MCP paths, tier routing, ledger journal, mock benchmark tool, Docker packaging and CI. Existing typecheck/tests/build passed independently.

Not completed/validated:

- Written Helius gateway/resale/Sender/staked-path permission and name/branding approval.
- Terms review of every public upstream; real production facilitator selection and fees.
- Real Helius/public-provider benchmarks from the deployment region.
- Mainnet USDC/facilitator deposit and refund lifecycle, finality/timeout recovery, treasury proof, funding and deployment approval.
- Customer-facing landing optimizer, durable inclusion lifecycle/SLA, or measured cheaper cost per landed transaction.
- Batch settlement, deferred as disclosed.

Fast is Helius routing, not a proven latency guarantee. Economy/standard inject confirmed while fast defaults to upstream commitment, usually finalized: benchmark identical commitment/method/region before tier comparisons. Mock load results (~2 ms low-load overhead, ~680 calls/s in the builder's environment) are not live Helius or total cost results.

sendTransaction is disabled by default. Enabled behavior is one foreground upstream attempt, with optional in-memory same-bytes rebroadcast. No fee/tip optimization or guarantee all sends land. Do not rebuild transactions blindly to escalate fees; different signatures can both execute without application-level protection.

## Permission and launch gates

Current Helius terms allow own-product integration in 3.1 while restricting third-party resale and competing services in 3.2. That is a real unresolved permission question, not legal clearance: https://www.helius.dev/terms .

Solana explicitly says shared public RPC endpoints are not intended for production apps: https://solana.com/docs/references/clusters . Free capacity is not a production entitlement/SLA.

Keep a neutral name until branding is approved; disclaimer alone does not settle affiliation risk. Do not bypass permission gates. No outreach is authorized by this review.

After fixes: run an approved, capped live pilot with identical workloads and measure p50/p95/p99, slot lag, 429s, fees and actual costs. For sends measure inclusion before expiry and on-chain errors separately from accepted-by-RPC. Verify mainnet mint/network, recipient ATA, fee payer, TLS/proxy trust, secrets, persistent storage, restores, alerts and custody/refund policy before taking deposits.

## Run the supplied evidence

Copy both scripts into the reviewed repo root. They are audit reproductions, not fixes:

```bash
npm ci
npm run build
node audit-repro.mjs
npx tsx audit-remote.ts
```

`audit-repro.mjs`: concurrent client budget, unresolved reconciliation, manual-recovery double credit and zero cap. `audit-remote.ts`: MCP spending survives revocation. No real funds or external RPCs used. Preserve them as regression cases after implementing fixes, changing assertions to require the safe behavior.
