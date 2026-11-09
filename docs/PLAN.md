# Helius Odometer

**Pay-per-call Solana RPC for AI agents. Wallet in, answers out. No signup, no email, no API key.**

Helius Odometer is an x402 payment gateway in front of Solana RPC. An agent pays in USDC from its own wallet, picks a speed tier, and gets routed accordingly: cheap reads from free public RPC, everything that needs it through Helius (DAS, Parsed Events, getProgramAccounts, staked sendTransaction). The name plays on the meter: an odometer counts every mile, Helius Odometer counts every call, and the fast lane costs more.

Naming status: the owner renamed the project from the working name "Turnpike" to "Helius Odometer" on 2026-11-09. Because the name includes "Helius", it implies a relationship with Helius that does not exist yet. Treat the name as part of the permission gate below: confirm with Helius that they are comfortable with it before any public use, and keep an unbranded fallback ready. Names already taken by adjacent products: Tollway (x402 project + TOLL token), Tollbooth (tollbooth.sh, x402), Slipstream (Solana relay), and Helius's own Gatekeeper, Sender and LaserStream.

## Guardrails for whoever builds this (including Claude)

This document is a research brief and build plan, not a set of pre-approved actions. The following each require the owner's explicit approval at the time, regardless of what the phases below say:

- Any purchase or payment (including the Helius Developer plan, domain names, hosting).
- Any paid deployment or infrastructure spend.
- Funding any wallet with real funds.
- Any outgoing message to anyone (including the Helius pitch email).
- Any public launch, listing, or announcement (x402-list, Bazaar, x402scan, social posts).

Phases describe what to build and prepare; they do not authorize execution of the above.

## Market state (verified 2026-11-09 unless noted)

Four vendor-run services already sell x402 pay-per-call Solana RPC with no key or subscription. None of the services checked in this research fronts Helius as its upstream, and we found no x402 endpoint shipped by Helius itself (a search result across the sources cited below, not a guarantee none exists); Helius's agent path is a one-time USDC payment that issues a conventional API key.

| Service | Price per call | Evidence |
|---|---|---|
| QuickNode x402 (`x402.quicknode.com`) | $0.001 per request; $0.0001 nanopayment (EVM-only, via Circle Gateway); credit drawdown $10/1M credits | Verified live 2026-11-09 (quicknode.com/x402, x402.quicknode.com/llms.txt) |
| Metaplex x402 (`api.metaplex.com/x402/rpc`) | $0.00001 default; getTransaction $0.00002; getBlock $0.00005; getSignaturesForAddress $0.0001 | Verified from their live pricing API 2026-11-09 |
| ERPC (`x402.erpc.global`) | Reported $0.001 minimum, method-weighted | Launch announcement confirmed (2026-07-04); current pricing not re-verified |
| Pocket Network Agentic Portal | Reported $0.005 (USDC on Base), read-only | Unverified, snippet-level; re-check |
| Helius "for Agents" | $10 USDC one-time, 1M credits, 10 req/s RPC, 2 req/s DAS. Issues an API key; not x402 | Verified live 2026-11-09 (helius.dev/docs/agents/overview) |

Open angles the incumbents appear not to cover (search findings, not proof of absence):

1. **Helius-backed and enhanced APIs behind a wallet instead of a key**: Helius products such as Parsed Events, the legacy Enhanced Transactions API (in maintenance mode), the Priority Fee API, getProgramAccountsV2 and getTransactionsForAddress, plus DAS methods. Note DAS is a shared Metaplex standard, not Helius-exclusive (Metaplex's own x402 service already sells DAS reads); the Helius-specific parts are the other APIs and their implementation quality. Pocket and ERPC present as vanilla read RPC.
2. **Transaction landing**: Helius staked connections and Sender (parallel Jito + SWQoS submission). The x402 RPC products found are read-centric.
3. **Speed as a priced question**: we did not find any RPC product, x402 or otherwise, that exposes a per-request latency contract. Absence of evidence here is a search result, not a guarantee; re-check before claiming it publicly.

## Payment model (the core constraint)

True per-call on-chain settlement looks uneconomic at RPC prices, based on this estimate: a Solana x402 `exact` settlement is a transaction with two signatures; the base fee is 5,000 lamports per signature (verified, solana.com/docs/core/fees), so 10,000 lamports per settlement, plus a facilitator fee where charged (CDP: first 1,000 on-chain settlements/month free, then $0.001 per settlement, per CDP docs as summarized by third-party trackers; re-verify on docs.cdp.coinbase.com). At an assumed $120/SOL that is roughly $0.0012-0.0022 per settlement. One Helius credit costs about $0.000005 at list prices ($5 per 1M additional credits, verified). So per-call settlement costs on the order of 200-400x the upstream credit it pays for. Treat the exact multiple as an estimate: it moves with the SOL price and facilitator tier.

Recommended model (recommendation, not a settled choice):

- **Launch: prepaid balance.** First request returns a 402 offering an `exact` USDC top-up (denominations TBD, e.g. $1/$5/$20). The gateway credits the payer wallet's balance when the facilitator settles; later requests authenticate with Sign-In-With-X (SIWx) and are debited per call off-chain. This mirrors QuickNode's verified credit-drawdown model and works with facilitators available today.
- **Later: `batch-settlement` payment channels** (one escrow deposit, per-call vouchers, one on-chain claim for many calls) as a second `accepts` option. Note: batch settlement on Solana moved from preview to production in October 2026 (PayAI facilitator, BlockRun first production user, announced 2026-10-07; docs.payai.network/x402/servers/batch-settlement). Verify PayAI's production terms and fees before depending on it. Keep deposits small and short-lived per the spec's credit-risk warning.
- **SDK versions, verified on npm/PyPI 2026-11-09:** `@x402/express` 2.30.0, `@x402/hono` 2.30.0, `@x402/mcp` 2.30.0, `@x402/svm`, and Python `x402[svm]` all exist and are current. Re-check versions at build time. Important: a published SIWx vulnerability (VulnCheck, 2026-10-20) affects `@x402/extensions` 2.3.1 through 2.28.0 (and x402 2.11.0-2.25.0); require a patched release (2.30.0 is current) and re-check advisories before shipping.

## Product design (proposals to validate, not commitments)

### Three speed tiers

Expose three paths (and three MCP tools): `economy`, `standard`, `fast`, each with a one-line description an LLM can relay to its user.

- **economy**: Class A reads served from the free public pool only, with no Helius fallback at all. If the pool is exhausted or a method is unsupported there, the request fails or queues and the agent is told why; it is never silently escalated into a cost the caller did not choose. May be slower; this is the cheap tier. (Alternative worth considering: an explicitly labeled, separately priced opt-in escalation. Do not mix the two silently.)
- **standard**: Class A from the free pool with automatic escalation to Helius on 429, timeout, slot lag, or error.
- **fast**: everything straight to Helius; sendTransaction via staked connections or Sender with the agent's chosen tip tier.

Do not publish latency numbers (e.g. p95 targets) until Phase 0 measurement against real upstreams produces them. Any tier target before then is a guess.

### Method classes (routing decision one, tier decision two)

- **Class A, public-eligible reads**: getSlot, getBlockHeight, getBalance, getAccountInfo, getMultipleAccounts, getTokenAccountBalance, getEpochInfo, getVersion, getLatestBlockhash, finalized getBlock/getTransaction (immutable, cacheable).
- **Class B, Helius-only for availability**: getProgramAccounts family, getTokenAccountsByOwner/Delegate, getTokenLargestAccounts, getSignaturesForAddress at scale, archival queries, all DAS methods, Parsed Events, Enhanced Transactions, Priority Fee API, getTransactionsForAddress, WebSocket subscriptions.
- **Class C, Helius-only for landing**: sendTransaction and freshness-sensitive simulateTransaction. Rationale: per Solana's SWQoS design, stake-weighted connections get priority leader access and unstaked (public) submissions are shed under congestion; re-verify current numbers before quoting.
- **Class D, blocked**: webhook management, account administration, anything mutating the gateway's own Helius account. Return 403.

Classes B and C are billed as Helius-backed regardless of tier; say so in the 402 response and MCP tool description so the agent is never surprised.

### Router behavior (study mature routers, don't invent)

Reference implementations: `erpc/erpc` (health polling, hedging rules) and `glamsystems/sol-rpc-router` (token buckets, method routes, ejection). Proposed behaviors:

- Per-upstream token buckets sized to published free-tier limits; cool an upstream on 429 for its Retry-After; eject on slot lag or consecutive health failures.
- Escalate to Helius instead of returning client-facing 429 when the free pool is exhausted (standard and fast tiers only; economy may queue or 429).
- Never retry, hedge, or mirror sendTransaction across upstreams.
- Sticky transaction sessions: getLatestBlockhash -> sendTransaction -> getSignatureStatuses on the same Helius upstream, with resends until lastValidBlockHeight.
- Consistency: normalize commitment per tier; track a per-wallet high-water-mark slot and inject `minContextSlot` where supported, capped conservatively (Thorchain hit -32020 errors doing this aggressively); re-route immediately on -32005 "Node is behind".
- Response headers naming upstream class, upstream context.slot, best-known slot, and measured upstream latency, so agents can verify what they paid for.

## Engineering requirements (non-negotiable)

- **Balance ledger integrity**: use a reserve/execute/finalize flow: reserve the call's price when a request is accepted, finalize (debit) when the upstream response is successfully handed back, release the reservation on failure. Do not promise atomic debit-with-delivery across a network boundary; instead guarantee convergence: idempotent receipts for every debit, a reconciliation job that compares reservations, debits and served responses, and an explicit written policy that any call charged but not successfully served is automatically refunded or re-credited.
- **Replay safety**: dedupe settlement events by transaction signature and payment payload; a replayed PAYMENT-SIGNATURE must not double-credit. SIWx auth must bind domain/URI (this is what the October 2026 advisory exploited).
- **Idempotency**: idempotency keys on top-ups, debits and RPC submission paths; a retried top-up credits once.
- **Refunds**: self-serve or on-request refund path for unused balances, plus the automatic failed-call refund policy above, both decided in writing before launch.
- **Key custody**: the server never takes custody of any client's signing keys. Clients sign their own payment transactions and SIWx messages; the server only verifies. The gateway's own Helius key and any fee-payer key live in server-side secrets management, never in client-visible paths.
- **Tests**: unit tests for the router (class assignment, escalation triggers, ejection), the ledger (credit/debit/replay/refund), and tier pricing; integration tests against devnet with a real facilitator testnet; a load test proving the gateway adds acceptable overhead before any tier claim is published.

## Pricing sketch (starting proposal, all figures re-verifiable before publishing)

Helius credit costs verified 2026-11-09: standard RPC 1 credit; getProgramAccounts 10; getProgramAccountsV2 1; DAS 10; Parsed Events 10; Enhanced Transactions 100 (maintenance mode); Priority Fee 1. Plans: Developer $49/mo for 10M credits at 50 req/s; Business $499 for 100M at 200 req/s; Professional $999 for 200M at 500 req/s.

| Gateway product | Helius credits/call | Proposed price/call | Reference points |
|---|---|---|---|
| Economy read (public pool only, no Helius fallback) | 0 | $0.00001 | Metaplex $0.00001 |
| Standard read (pool + Helius escalation) | 1 when escalated | $0.00003 | QuickNode/ERPC ~$0.001 |
| DAS / gPA / Parsed Events | 10 | $0.0002 | Metaplex heavy $0.0001 |
| Enhanced Transactions (legacy) | 100 | $0.002 | none found |
| sendTransaction (staked path) | 1 + user-paid tip | $0.001 | QuickNode $0.001 |

Illustrative mix economics, computed from the table above at a 70% economy / 25% standard-escalated / 5% DAS mix:

- Revenue per call: 0.70 x $0.00001 + 0.25 x $0.00003 + 0.05 x $0.0002 = $0.0000245, i.e. **$0.0245 per 1,000 calls**.
- Helius credits burned per 1,000 calls: 1000 x (0.25 x 1 + 0.05 x 10) = 750 credits. Valued at the additional-credit rate ($5/M): **$0.00375** marginal per 1,000 calls.

Keep the two cost kinds separate: the $49 Developer plan is a **fixed monthly cost** that includes 10M credits; credit burn only becomes a **marginal** cost once included credits run out. At the illustrative mix, Helius-subscription break-even (revenue covering the $49 alone) lands at 2.0M calls/month, consuming about 1.5M of the 10M included credits. That is not a business break-even: hosting, facilitator fees beyond free tiers, refunds, failed-call credits and development time are all additional and unestimated here. The practical growth ceiling is per-plan rate limits (sendTransaction is reported at 5/s on Developer, 50/s on Business; re-verify) rather than credits.

Demand caution (unverified figures, listed so nobody quotes them as fact): the original research cites ~1.6K monthly active Solana x402 senders, estimates that 78-98% of tracked x402 volume in some periods was incentivized, and one paid-MCP operator's report of "533 handshakes in a day, 0 tool calls". Directionally these say agents discover paid endpoints far more than they pay them; treat the numbers as leads, and instrument the 402-served -> balance-funded -> calls-made funnel from day one.

## The permission gate (unresolved, and it gates launch)

Verified verbatim from the Helius Cloud Services Agreement (helius.dev/terms, last updated 2026-09-28, pulled 2026-11-09):

- Section 3.1 permits use "limited to Customer's business purposes, including integration of the Services into Customer's own products and services."
- Section 3.2 prohibits, among other things: "(ii) except as otherwise permitted under Section 3.1, sell, resell, sublicense, rent, distribute, or provide the Services to third parties except as expressly authorized" and "(vii) use the Services to develop a competing service."
- One Authorized User per account; Helius may change the terms at any time.

Whether a metered gateway in front of Helius is permitted "integration" or prohibited "resale" is **unresolved, and this document takes no position on it**. Architecture choices (multiple upstreams, own metering, caching, wallet auth) may be relevant to the answer but do not settle it; only Helius can. Commercial launch is gated on written Helius permission regardless of how the system is built. Related hard rules regardless of permission: exactly one Helius account (the Terms of Use limit each entity to one), no multiplying free tiers for capacity, and an explicit answer from Helius on whether Sender may be fronted before sendTransaction is offered.

The same question applies to every other upstream in the pool. Free public endpoints and free tiers have their own acceptable-use terms, and this research did not check whether each provider's terms permit serving their capacity to paying third parties through a gateway. Phase 0 must include a terms review of every upstream used (public endpoint, PublicNode, Solana Tracker, Shyft, Alchemy free tiers, and any other candidate), not just Helius; drop or replace any whose terms do not clearly allow the planned use.

Practical handling (all outreach requires owner approval per the guardrails):

1. Prepare a short pitch to Helius (draft in the original research; to be rewritten and approved before sending) asking for written confirmation under 3.1 or an Enterprise/reseller arrangement with custom rate limits.
2. Keep the upstream abstraction honest from day one so the Helius-backed tier can swap to another provider if Helius declines.
3. If Helius declines or stays silent, launch options are: proceed only with non-Helius upstreams, or don't launch. Do not launch a Helius-backed paid gateway without written permission.

Possible longer-term outcomes, with no commitment implied: operating independently with Helius's blessing, becoming a listed/sanctioned partner, or Helius building or acquiring this capability. Whether any of these is desirable is the owner's call, made later, with data in hand.

## Build phases

**Phase 0: measurement and permission prep (no spend without approval).**
With owner approval, buy a Developer plan paid in USDC so costs and revenue share one asset. Stand up measurement before routing code: run `helius-labs/rpc-perf-dash` (or equivalent) from the intended hosting region against Helius, api.mainnet-beta.solana.com, PublicNode, and other candidate upstreams; record per-method p50/p95, 429 rates, and slot lag. These numbers become the tier targets. Re-read both Helius terms documents in full. Draft the Helius pitch for owner review.

**Phase 1: paid MVP, Helius-only, one tier.**
Hono or Express service with `@x402/hono`/`@x402/express` + `@x402/svm` (verified current above) and the CDP facilitator for verify/settle (facilitator choice is a recommendation; compare PayAI and CDP terms first). Prepaid balance keyed to payer wallet, SIWx verification on a patched `@x402/extensions`, per-method price table, free `GET /pricing` (Metaplex style), Bazaar extension metadata on the 402 for discovery. Ship exactly one honestly named Helius-backed tier in this phase. Do not expose `economy` or `standard` yet: with all traffic routed to Helius they would be indistinguishable paid labels for the same service, and an `economy` price for Helius-served calls contradicts its public-only cost basis. The three-tier split ships only when the Phase 2 router gives the tiers real, different behavior. MCP transport via `@x402/mcp` alongside HTTP, exposing that single tier as one tool whose description tells the agent what it buys; the split into separate per-tier tools (each telling the agent to ask its user how important speed is) lands in Phase 2 with the router. Python client example using `x402[svm]`. Directory listings (Bazaar, x402-list, x402scan) count as public launch: owner approval first.

**Phase 2: routing engine.**
Public upstream pool with token buckets, slot-lag polling, 429 cooling, ejection, Helius escalation. Method classifier, commitment normalization, minContextSlot high-water marks, sticky transaction sessions, diagnostic headers, immutable caching of finalized getBlock/getTransaction. sendTransaction via staked connections, fast tier only, never retried across upstreams, gated on Helius's explicit answer about fronting Sender. Status page publishing measured per-method p50/p95 per tier.

**Phase 3: scale and settlement, gated on Helius.**
If Helius says yes: move to a plan with adequate rate limits, prepaid credits in USDC. If no: swap the Helius-backed tier to another provider or cut those methods. Add `batch-settlement` as a second `accepts` option after verifying facilitator production support. Per-wallet spend caps and the refund path. Review the conversion funnel.

## Open decisions for the owner and builder

1. Top-up denominations and minimum balance.
2. Final tier price points (the table is a starting proposal sitting between Metaplex's low default and QuickNode/ERPC's $0.001).
3. Whether to offer an advanced `maxLatencyMs` routing knob later. Sequencing is: one Helius-backed tier in the MVP, then the three-tier router in Phase 2; any extra knob comes after that.
4. Facilitator choice for top-ups (CDP vs PayAI vs self; compare live fee schedules).
5. Balance posture: custody wording, refund mechanics, spend caps.
6. Whether to approach Helius before or after a working MVP exists; each has a cost, and outreach needs owner approval either way.
7. Whether any partnership or acquisition outcome is a goal at all. Not assumed.

## Verification ledger

Verified against live sources on 2026-11-09:

- Helius Cloud Services Agreement sections 3.1/3.2 (quoted above), helius.dev/terms
- Helius Agent plan ($10 one-time, 1M credits, 10 req/s RPC, 2 req/s DAS) and Developer/Business/Professional tiers, helius.dev/docs/agents/overview (this also resolves the original research's 1 USDC vs $10 discrepancy: live docs say $10)
- Helius credit costs per method, helius.dev/docs/billing/credits
- Metaplex x402 endpoints and per-method prices, api.metaplex.com/x402/pricing (live API)
- QuickNode x402 models and prices, x402.quicknode.com/llms.txt
- x402 batch settlement in production on Solana via PayAI (announced 2026-10-07), docs.payai.network/x402/servers/batch-settlement
- SIWx SDK vulnerability affecting @x402/extensions 2.3.1-2.28.0, VulnCheck advisory dated 2026-10-20; current package versions (@x402/express, /hono, /mcp 2.30.0; Python x402[svm]) on npm/PyPI
- Solana base fee of 5,000 lamports per signature, solana.com/docs/core/fees
- ERPC x402 launch announcement, erpc.global/en/news/2026/07/04

Not independently verified (from the original research; re-check before relying on or quoting):

- Pocket Network Agentic Portal pricing and terms
- Corbits Helius demo uptime and facilitator volume figures
- Facilitator fee schedules beyond the CDP summary above; the per-settlement dollar cost depends on SOL price
- Free-pool capacity figures (public endpoint limits, Solana Tracker, Shyft, Alchemy free tiers)
- Latency benchmarks from any vendor or third party; vendor benchmarks disagree, so measure your own in Phase 0
- x402 market-size, sender-count, and incentivized-volume statistics
- sendTransaction per-plan rate caps (5/s Developer, 50/s Business)

## Sources

- https://www.helius.dev/terms
- https://www.helius.dev/docs/agents/overview
- https://www.helius.dev/docs/billing/credits
- https://www.metaplex.com/docs/agents/x402 and https://api.metaplex.com/x402/pricing
- https://www.quicknode.com/x402 and https://x402.quicknode.com/llms.txt
- https://docs.payai.network/x402/servers/batch-settlement
- https://www.vulncheck.com/advisories/x402-x402-extensions-2.3.1-through-2.28.0-siwx-payment-bypass-via-paymentpayload-resource
- https://www.npmjs.com/package/@x402/express , https://www.npmjs.com/package/@x402/hono , https://www.npmjs.com/package/@x402/mcp and https://pypi.org/project/x402/
- https://solana.com/docs/core/fees
- https://erpc.global/en/news/2026/07/04/erpc-x402-agent-payments-20260704/
- https://github.com/coinbase/x402 (specs: transports-v2/http.md, schemes/exact/scheme_exact_svm.md, schemes/batch-settlement/scheme_batch_settlement_svm.md, extensions/sign-in-with-x.md, extensions/bazaar.md)
- https://github.com/solana-foundation/payment-channels
- https://github.com/helius-labs/rpc-perf-dash
- https://github.com/erpc/erpc and https://github.com/glamsystems/sol-rpc-router

*Compiled 2026-11-09. Independent verification of the original research report plus live source checks. The original report's full evidence table, market sizing, and pitch draft are preserved in the source document.*

---

*Renamed from the working name Turnpike to Helius Odometer on 2026-11-09. Implementation status lives in the README and docs/ARCHITECTURE.md.*
