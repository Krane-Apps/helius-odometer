# Upstream and provider terms checklist (Phase 0)

The plan requires a terms review of **every** upstream before its capacity serves paying users ([plan](PLAN.md#the-permission-gate-unresolved-and-it-gates-launch)). None of the items below has been reviewed yet; this session could not reach any provider's site. Drop or replace any provider whose terms do not clearly allow the planned use.

For each provider, answer:

1. Does the free tier or public endpoint allow commercial use?
2. Does it allow serving its capacity to third parties through a gateway that charges them?
3. Are there rate, attribution or "no proxying or reselling" clauses?
4. Is an account or API key required, and is one account per entity enforced?
5. Can the terms change without notice, and how would we learn about it?

## Helius

| Item | Source | Status |
|---|---|---|
| Section 3.1: integration into the customer's own products | helius.dev/terms | Quoted in the plan; interpretation unresolved |
| Section 3.2(ii) and (vii): no resale, no competing service | helius.dev/terms | Quoted in the plan; interpretation unresolved |
| One Authorized User per account; one account per entity | helius.dev/terms, docs Terms of Use | Noted; never multiply free accounts |
| May Sender and staked connections be fronted? | Ask Helius directly | Open; `sendTransaction` disabled until answered |
| Is the name "Helius Odometer" acceptable? | Ask Helius directly | Open |
| Per-plan rate limits (RPC, `sendTransaction`, DAS) | Helius pricing and docs | Re-verify before setting `HELIUS_*_RPS` |

## Public RPC candidates

| Provider | Endpoint | Status |
|---|---|---|
| Solana Foundation public endpoint | api.mainnet-beta.solana.com | Not reviewed. Officially not for production use; rate limits change without notice. |
| PublicNode (Allnodes) | solana-rpc.publicnode.com | Not reviewed |
| Solana Tracker free tier | per provider docs | Not reviewed |
| Shyft free tier | per provider docs | Not reviewed |
| Alchemy free tier | per provider docs | Not reviewed |
| dRPC free tier | per provider docs | Not reviewed |
| Triton public pool | per provider docs | Not reviewed |
| Ankr public | per provider docs | Not reviewed |

## x402 facilitators

| Facilitator | Questions | Status |
|---|---|---|
| Coinbase CDP | Fees after the free tier, Solana mainnet support, API key terms, Bazaar listing behavior | Not reviewed |
| PayAI | Fees, production status of Solana `exact` and batch settlement, uptime commitments | Not reviewed |
| Self-hosted (`npm run facilitator`) | Fee-payer key custody, SOL float, RPC dependency | Our responsibility |

## Record of decisions

| Date | Provider | Decision | Evidence |
|---|---|---|---|
| | | | |
