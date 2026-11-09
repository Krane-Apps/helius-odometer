# Helius pitch (draft, not sent)

> **Draft for the owner to rewrite and approve. Nothing here has been sent.** Outreach needs explicit owner approval ([guardrails](PLAN.md#guardrails-for-whoever-builds-this-including-claude)). Before sending, confirm each recipient's current role at Helius, re-verify the competitor facts, and replace the bracketed placeholders.

## Short version (DM)

> Hi [name], I built Helius Odometer: pay-per-call Solana RPC for AI agents over x402, in front of Helius. An agent pays USDC from its own wallet, with no signup or API key. It pays one on-chain top-up, then each call is metered off-chain. Per-call settlement costs more than the call itself, so prepaid metering is what makes the economics work.
>
> It has three tiers. Cheap reads go to free public RPC and fall back to Helius automatically. DAS, getProgramAccounts and transaction landing always go to Helius. It's tested end to end on a local validator with real x402 settlement, and it works with stock x402 HTTP and MCP clients.
>
> Before I take any traffic through Helius I'd like your written OK, or the right arrangement. Can I send you the repo and a 2-minute demo?

## Longer version (email)

**Subject:** x402 pay-per-call access to Helius for AI agents (asking permission before launch)

Hi [name],

I'm [your name] ([link]). Agents increasingly need Solana data, but they can't sign up for accounts or manage API keys. x402 solves the payment half. Several providers already sell x402 Solana RPC, including QuickNode and Metaplex, but Helius's data and landing infrastructure isn't reachable that way yet.

I built **Helius Odometer**, an x402 gateway in front of Helius:

- **No account, no key.** An agent's wallet pays a USDC top-up through x402; Sign-In-With-Solana and short-lived sessions handle everything after that.
- **Economics that work.** One on-chain top-up, then off-chain metering per call, so payment overhead doesn't swamp a call that costs Helius a few millionths of a dollar.
- **Speed is a priced choice.** Economy reads go to free public RPC only. Standard falls back to Helius on 429s, timeouts or lag. Fast always uses Helius. DAS, program scans and transaction landing always go to Helius, at the same price on every tier.
- **Honest operation.** Delivery failures are never charged, every response says which upstream served it and what it cost, and operators verify settlements against the chain before resolving them.
- **Tested.** The end-to-end suite runs a real validator with real x402 settlement, a stock x402 client, and MCP agents over both stdio and remote MCP.

**What I'm asking for before any launch:**

1. Written confirmation that this counts as permitted integration under section 3.1 of your Cloud Services Agreement, or the reseller or Enterprise arrangement you'd prefer.
2. Whether Sender and staked connections may be fronted. `sendTransaction` stays disabled until you say so.
3. Whether you're comfortable with the name "Helius Odometer", or what you'd prefer it be called.
4. If it's interesting to you, I'd be glad to run it as a sanctioned partner, or hand it over.

I can share the repo and a 2-minute local demo: `npm run localnet -- --demo`.

Thanks,
[your name]

## Checklist before sending

- [ ] Owner approved sending, and approved the recipients.
- [ ] Recipient roles confirmed from current, primary sources.
- [ ] Competitor claims re-checked against the live pages on the day of sending.
- [ ] Demo re-recorded from the latest commit.
- [ ] Decided whether to share the private repository, or only a demo.
