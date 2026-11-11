# Helius Odometer review - 11 November 2026

Reviewed HEAD `fdc5a2742ebb442f3a40daa80eacef95b8e13721`, independently cloned from the public repository. HEAD was unchanged at the end of review.

## Verdict

Do not take customer deposits yet. The earlier fixes are present and their regression checks pass, but this review reproduces a new remote-MCP allowance race and a REST billing error. Funding/replay ordering also needs correction. This is a focused review, not a formal security audit or proof that no other bugs exist.

## Independently verified

- Installed with `npm ci --ignore-scripts`.
- `npm run typecheck`: passed.
- `npm test`: 134 tests passed across 18 files.
- `npm run build`: passed.
- `npm run test:audit`: both supplied offline audit scripts passed their safe-behavior assertions.
- `npm run test:e2e`: all 10 tests skipped because no Solana validator is installed here. No independent local-chain or production payment validation.
- `npm audit --omit=dev`: zero known dependency vulnerabilities reported. This is not security clearance.
- Custom reproductions used only local HTTP servers, fake facilitators and mock ledger balances. No real funds, secrets, deployment, code commits or production mutations.

## P1: Concurrent MCP calls overspend their session voucher

Source: `src/mcp/remote.ts`, especially `spendable()` before routing, reservation at line 424 and voucher decrement at line 464.

A bare MCP session is intended to spend only the amount topped up within that session, not the wallet's other balance. Calls check the voucher before awaiting the router, but do not reserve voucher funds. The ledger reserves against the whole wallet. Parallel calls all pass against the same old voucher value and debit older wallet funds when they complete.

Reproduced: wallet had 1,000,000 micros in old balance; session topped up 20 micros; first call spent 10 micros. With only 10 micros voucher remaining, four concurrent getSlot calls all succeeded and debited 40 micros. Final wallet balance was 999,970 micros, meaning 30 micros of older balance were spent beyond the session's allowance.

Prerequisites: a valid funded MCP session and wallet funds beyond the remaining voucher. This is not private-key theft or an unlimited balance bypass. Rate and wallet daily caps still apply, but do not enforce the session-specific allowance.

Fix: atomically reserve session allowance before any awaited routing, refund unused allowance after unbilled failure, and prevent settlement/rebinding from corrupting in-flight accounting. Alternatively serialize paid calls per session. Add concurrent calls, mixed billable/unbillable outcomes, rebinding and revocation regression cases.

Evidence: `helius-review-new-repros.ts`, printed `concurrentSuccesses:4,debit:40` with `voucherRemaining:10`.

## P1: REST passthrough bills operator upstream-auth failures

Source: `src/rpc/helius-rest.ts:94-106`.

Every HTTP 4xx except 429 is billed. That includes an upstream 401 caused by the operator's invalid Helius API key, not the customer's request.

Reproduced locally: mock Helius REST returned HTTP 401 and `{error:"Invalid API key"}`. The gateway returned 401 and `X-Odometer-Charged:2000`; a 10,000-micro balance fell to 8,000. The customer paid $0.002 for a gateway configuration failure.

Fix: classify REST errors independently, leaving authentication, entitlement, route/configuration and delivery failures unbilled. Explicitly define any billable customer-input errors and reflect them in shared billing documentation. Add REST-specific 401/403/404/429/5xx and body-error tests, rather than relying on the JSON-RPC billing suite.

Evidence: `helius-review-rest-repro.ts`, printed `status:401,chargedMicros:"2000",balance:8000`.

## P2: Paid-response replay requires a new funded balance

Source: `src/rpc/metered.ts:63` calls `paywall.authorize` before idempotency lookup at lines 90-103; `src/payments/paywall.ts:87-94` challenges an authenticated wallet when balance is low. MCP likewise checks funding before its receipt lookup.

Reproduced on HTTP: wallet funded with exactly 10 micros; first getSlot with an Idempotency-Key returned 200 and used the balance. Repeating the identical request/key returned 402 insufficient_balance, without the replay header, instead of returning its already-paid stored answer.

Impact: lost-response recovery can trigger an unnecessary new on-chain top-up with the automatic client. This is not a second RPC debit: the receipt still prevents the original request being charged twice once the balance gate is passed.

Fix: separate proof of wallet identity from new-spend authorization. After verifying identity, validate the key/fingerprint and return a completed receipt without requiring funding or top-up. Check funding only for a genuinely new operation. Add depleted-balance HTTP and MCP replay cases.

Evidence: `helius-review-new-repros.ts`, printed `firstStatus:200,secondStatus:402,replay:null,balance:0`.

## P2: Stopped wallets are still asked to top up

Same funding-first ordering as above. The daily-cap check occurs only during reservation, after the payment path.

Reproduced: an authenticated unfunded wallet with its cap set to zero received 402 insufficient_balance and advertised top-up denominations. The existing automatic client handles that as a payment opportunity. Spending is stopped correctly at reservation, but money can first be deposited into an account unable to make the requested call.

Fix: for an identified wallet, reject stopped/exhausted caps and other deterministic new-call policy failures before offering or signing an automatic top-up. Keep deliberate explicit top-up behavior separate. Test no payment authorization occurs when the call is already forbidden.

Evidence: `helius-review-rest-repro.ts`, printed `CAP_ZERO_UNFUNDED` with status 402 and top-up instructions.

## Additional static issue to fix or test

`src/routing/router.ts:463-472` always sets rebroadcast upstream to `pool.helius`, even when initial `target` is `pool.sender`. `src/routing/rebroadcast.ts` says it resends to the same upstream, never a different upstream. With Sender plus rebroadcast enabled, that implementation contradicts the documented same-path behavior. No live send or on-chain reproduction was attempted. Decide the intended path, pass the selected target or document the deliberate switch, and add a Sender-plus-rebroadcast regression. sendTransaction remains disabled by default.

## Earlier review status

Current code and passing local regressions address the earlier zero-cap bypass, concurrent client signing budget, revoked MCP spending and manual settlement double-credit cases. Atomic debit/receipt tests and restart/lock tests also pass. Do not continue describing those old reproductions as current failures.

The billing contract deliberately permits specified client-error JSON-RPC answers to be billed; this is different from promising all failures are free. A charged sendTransaction is RPC acceptance, not proof of landing.

## Still outside this review

Written Helius gateway and name permission; public-upstream production terms; selected production facilitator and fees; live mainnet USDC deposits/refunds and ambiguous/finality recovery; regional performance measurements; real deployment storage/restore, TLS/proxy and alert delivery checks. The repository itself lists permission and live-pilot gates. No launch clearance is implied by passing tests.
