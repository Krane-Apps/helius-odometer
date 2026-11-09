# Operations

Everything here describes how to run the gateway. Buying a Helius plan, funding wallets, deploying and any public listing each need the owner's explicit approval first ([guardrails](PLAN.md#guardrails-for-whoever-builds-this-including-claude)).

## Before the first deployment

1. **Written Helius permission** for a metered gateway in front of Helius, including whether Sender and staked connections may be fronted. Until then keep `ENABLE_SEND_TRANSACTION=false` and do not take commercial traffic through Helius.
2. **Terms review of every public upstream** ([checklist](UPSTREAM_TERMS_CHECKLIST.md)). Drop any whose terms do not clearly allow serving paying users.
3. **Measure the real upstreams** from the hosting region with `odometer-bench` (below) before publishing any latency expectation.
4. **Choose a facilitator.** Any x402 v2 facilitator with Solana mainnet `exact` support works. Compare live fee schedules and terms (Coinbase CDP, PayAI, others), or self-host with `npm run facilitator` and a funded fee-payer key.
5. **Create the operator wallet's USDC token account** (`PAYTO_ADDRESS`). Top-up transfers fail if the destination associated token account does not exist.
6. **Generate secrets:** `SESSION_SECRET` (32+ characters) and `ADMIN_TOKEN` (16+ characters).

## Running

### Docker

```bash
docker build -t helius-odometer .
```

```bash
docker run -d --name odometer -p 8787:8787 --env-file .env -v odometer-data:/data helius-odometer
```

The image runs as the non-root `node` user, stores the ledger at `/data/odometer.db`, and has a health check on `/health`. Put it behind a TLS-terminating proxy, set `PUBLIC_ORIGIN` to the public `https://` origin, and set `TRUST_PROXY=true` only if the proxy sets `X-Forwarded-For`.

### Directly

```bash
npm ci && npm run build && node dist/server/main.js
```

### Self-hosted facilitator (optional)

```bash
FACILITATOR_KEYPAIR=/secure/fee-payer.json \
FACILITATOR_RPC_URL="https://mainnet.helius-rpc.com/?api-key=..." \
FACILITATOR_NETWORKS=solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp \
npm run facilitator
```

The fee payer co-signs and pays network fees for every top-up, so it needs SOL. `FACILITATOR_TX_VERSIONS` defaults to `0`; add `1` once your RPC supports version-1 transactions.

## Sizing Helius

The binding constraint is the plan's request rate, not credits. Set `HELIUS_RPS`, `HELIUS_SEND_TX_RPS` and `HELIUS_HEAVY_RPS` to your plan's published limits. The gateway then answers 429 (not charged) instead of letting Helius reject calls. `GET /admin/stats` estimates Helius credits used and gross margin at list price.

Health probes cost credits too. One `getSlot` per `HELIUS_HEALTH_POLL_MS` (default 30 s) is about 86,000 credits a month.

## Measuring upstreams (Phase 0)

```bash
npm run bench -- \
  --upstream solana=https://api.mainnet-beta.solana.com \
  --upstream helius="https://mainnet.helius-rpc.com/?api-key=$HELIUS_API_KEY" \
  --duration 120 --rps 2 --methods getSlot,getLatestBlockhash,getBalance,getAccountInfo \
  --out bench.json
```

It prints p50, p95 and p99 latency, 429 and error counts per upstream and method, plus slot lag against the best upstream at each moment. Keep `--rps` within each provider's published free limits. API keys are redacted from the report.

## Monitoring

| Endpoint | What to watch |
|---|---|
| `GET /health` | `paymentsReady` (facilitator synced), upstream availability |
| `GET /status` | Measured latency per tier, method and upstream class; upstream health and slot lag |
| `GET /admin/stats` | Funnel (challenges, sign-ins, top-ups, funded and spending wallets), revenue, Helius credit estimate, top-up status counts |

Logs are one JSON object per line. Alert on `ledger reconciliation mismatch`, `top-up settled but not recorded`, and `upstream ejected` (when sustained).

If the facilitator is unreachable, funded wallets keep working. Only new top-ups fail, with a 503 and `Retry-After`.

## Admin API

All requests need `Authorization: Bearer $ADMIN_TOKEN`.

| Request | Purpose |
|---|---|
| `GET /admin/stats` | Funnel, revenue, credit estimate, upstreams |
| `GET /admin/accounts/{wallet}` | Balance, journal, top-ups, refunds for one wallet |
| `POST /admin/accounts/{wallet}/adjust` `{"amountUsd": 1.5, "note": "..."}` | Journaled goodwill credit or debit. Never use it to recover a top-up; it is refused while the wallet has unresolved top-ups. |
| `GET /admin/topups?status=needs_review` | Settlements that need a human |
| `GET /admin/topups/{id}/verify` | On-chain evidence for a top-up: finalized, successful, amount received by `PAYTO_ADDRESS`, payer |
| `POST /admin/topups/{id}/resolve` `{"action": "credit", "note": "..."}` | Credit the original receipt once, after the evidence matches. `"reject"` records that nothing moved. |
| `GET /admin/refunds?status=requested` | Refund queue |
| `POST /admin/refunds/{id}` `{"status": "paid", "txSignature": "..."}` | Record a refund payout (or `"rejected"` to re-credit) |
| `POST /admin/reconcile` | Run reconciliation now |

## Runbooks

### A top-up is flagged `needs_review`

Money may have moved without being credited: the facilitator timed out, reported a pending settlement, or broadcast a transaction that was not confirmed. The payment is frozen, and resending the same signed payment is refused.

1. Run `GET /admin/topups/{id}/verify`. If no signature is recorded, find it in the logs or on an explorer and pass `?txSignature=`.
2. If `matches` is true (finalized, successful, the expected amount reached `PAYTO_ADDRESS`), resolve it with `POST /admin/topups/{id}/resolve` and `{"action": "credit", "note": "..."}`. This credits the original receipt exactly once, with the receipt's own amount. A delayed completion or replay of the same payment then credits nothing.
3. If nothing landed, resolve it with `{"action": "reject", "note": "..."}`. If that payment settles later after all, it returns to review instead of crediting automatically.

Never recover a top-up with a manual adjustment. An adjustment is not linked to the receipt, so a later completion of the same payment would credit it a second time. `"force": true` skips the on-chain check and is for the rare case where the evidence must come from elsewhere; it requires `wallet` and a note.

### A refund is requested

The amount has already left the wallet's available balance. Send USDC from the operator wallet to the refund's `destination`, then record the payout with `POST /admin/refunds/{id}` and `"status": "paid"`. Refunds are never paid automatically: sending funds needs operator approval.

### Reconciliation reports a mismatch

Stop taking traffic, back up the database, and compare the wallet's `journal` with `accounts`. Reconciliation never auto-corrects balances, because a silent fix would hide a bug.

### Rotating secrets

- Rotating `SESSION_SECRET` logs every agent out. They sign in again automatically.
- Rotating `ADMIN_TOKEN` affects only operators.

## Backups

The ledger is a single SQLite file in WAL mode. Back it up with `sqlite3 /data/odometer.db ".backup /backups/odometer-$(date +%F).db"`, or snapshot the volume. Balances are liabilities to agents, so treat this file like a financial record.
