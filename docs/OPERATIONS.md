# Operations

Everything here describes how to run the gateway. Buying a Helius plan, funding wallets, deploying and any public listing each need the owner's explicit approval first ([guardrails](PLAN.md#guardrails-for-whoever-builds-this-including-claude)).

## Before the first deployment

1. **Written Helius permission** for a metered gateway in front of Helius, including whether Sender and staked connections may be fronted. Until then keep `ENABLE_SEND_TRANSACTION=false` and do not take commercial traffic through Helius.
2. **Terms review of every public upstream** ([checklist](UPSTREAM_TERMS_CHECKLIST.md)). Drop any whose terms do not clearly allow serving paying users.
3. **Measure the real upstreams** from the hosting region with `odometer-bench` (below) before publishing any latency expectation.
4. **Choose a facilitator.** Any x402 v2 facilitator with Solana mainnet `exact` support works. Compare live fee schedules and terms (Coinbase CDP, PayAI, others), or self-host with `npm run facilitator` and a funded fee-payer key.
5. **Create the operator wallet's USDC token account** (`PAYTO_ADDRESS`). Top-up transfers fail if the destination associated token account does not exist.
6. **Generate secrets:** `SESSION_SECRET` (32+ characters) and `ADMIN_TOKEN` (16+ characters).
7. **Route alerts to a person:** set `ALERT_WEBHOOK_URL` (a Slack-compatible incoming webhook or a pager bridge). Without it, alerts only reach the logs.
8. **Use a neutral public name** in `SERVICE_NAME` until the Helius name is approved for this use. It appears on the paywall page, the index, `llms.txt`, the SIWx sign-in statement and Bazaar metadata.
9. **Check readiness:** `GET /admin/readiness` must answer `"ready": true` before taking deposits (below).

## Running

### Docker

```bash
docker build -t helius-odometer .
```

```bash
docker run -d --name odometer -p 8787:8787 --env-file .env -v odometer-data:/data helius-odometer
```

The image runs as the non-root `node` user, stores the ledger at `/data/odometer.db`, and has a health check on `/health`. Put it behind a TLS-terminating proxy, set `PUBLIC_ORIGIN` to the public `https://` origin, and set `TRUST_PROXY=true` only if the proxy overwrites `X-Forwarded-For`.

Run exactly one gateway process per database. A second process against the same file refuses to start (`ledger_locked`). Deploy by stopping the old process before starting the new one: a clean stop releases the lock at once, while a crashed process holds it until its heartbeat is 30 s old. If a stalled process loses the lock to another, it raises an alert and exits.

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
| `GET /admin/readiness` | The launch gates the gateway can check itself (below) |

### Alerts

Every alert is logged as `ALERT <message>`. With `ALERT_WEBHOOK_URL` set it is also POSTed as JSON (`service`, `severity`, `key`, `message`, `details`, `at`, and a `text` line for Slack-style webhooks), with `ALERT_WEBHOOK_AUTH_HEADER` as its `Authorization` header if set. Repeats of one key are suppressed for `ALERT_DEDUPE_MINUTES` (default 15).

| Key | Severity | Meaning | Do |
|---|---|---|---|
| `settlement:<payload hash>` | critical | A top-up's settlement outcome is unknown; the payment is frozen | [needs_review runbook](#a-top-up-is-flagged-needs_review) |
| `unrecorded:<signature>` | critical | Funds settled on-chain but the ledger could not record the credit | [needs_review runbook](#a-top-up-is-flagged-needs_review) |
| `reconcile-mismatch` | critical | A balance disagrees with its journal | [mismatch runbook](#reconciliation-reports-a-mismatch) |
| `reconcile-unresolved` | warning | Top-ups with an unknown outcome are waiting for review | [needs_review runbook](#a-top-up-is-flagged-needs_review) |
| `writer-lock` | critical | Another process took over the ledger; this one exits | Find the second instance |

Logs are one JSON object per line. Also watch for sustained `upstream ejected`.

### Readiness

`GET /admin/readiness` answers `ready` plus one result per check. `fail` means do not take deposits; `warn` is advisory.

| Check | Fails when |
|---|---|
| `facilitator` | The facilitator is not synced, or offers no Solana fee payer |
| `public_origin` | `PUBLIC_ORIGIN` is not HTTPS on mainnet (a warning elsewhere) |
| `storage` | The ledger is in memory |
| `session_secret` | `SESSION_SECRET` is not set |
| `writer_lock` | This process does not hold the ledger's writer lock |
| `ledger_arithmetic` | A balance disagrees with its journal, or reserved funds with open reservations |
| `unresolved_topups` | Any top-up's outcome is unknown |
| `custody` | `PAYTO_ADDRESS` has no associated token account for the payment asset, holds less than agents are owed (balances plus pending refunds, at `confirmed`), or cannot be read |

Warnings: `alerts` (no webhook), `network` (not mainnet USDC), `public_listing` (Bazaar on), `send_transaction` (enabled), `branding` (the public name includes Helius).

Readiness does not cover what needs a human: upstream permission, terms, facilitator fees, a restore drill, and the refund policy.

If the facilitator is unreachable, funded wallets keep working. Only new top-ups fail, with a 503 and `Retry-After`.

## Admin API

All requests need `Authorization: Bearer $ADMIN_TOKEN`.

| Request | Purpose |
|---|---|
| `GET /admin/stats` | Funnel, revenue, credit estimate, upstreams |
| `GET /admin/accounts/{wallet}` | Balance, journal, top-ups, refunds for one wallet |
| `POST /admin/accounts/{wallet}/adjust` `{"amountUsd": 1.5, "note": "..."}` | Journaled goodwill credit or debit. Never use it to recover a top-up: a credit is refused (409 `unresolved_topups`) while a top-up that could credit the wallet is settling or under review. Set `acknowledgeUnresolvedTopups: true` only for a credit unrelated to any top-up. |
| `GET /admin/topups?status=needs_review` | Settlements that need a human |
| `GET /admin/topups/{id}/verify` | On-chain evidence for a top-up: finalized, successful, amount received by `PAYTO_ADDRESS`, payer |
| `POST /admin/topups/{id}/resolve` `{"action": "credit", "note": "..."}` | Credit the original receipt once, after the evidence matches. `"reject"` records that nothing moved. |
| `GET /admin/refunds?status=requested` | Refund queue |
| `POST /admin/refunds/{id}` `{"status": "paid", "txSignature": "..."}` | Record a refund payout (or `"rejected"` to re-credit) |
| `POST /admin/reconcile` | Run reconciliation now: local arithmetic, unresolved top-ups, liabilities |
| `GET /admin/readiness` | Pre-deposit checks, including custody read from the chain |

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

### The gateway refuses to start with `ledger_locked`

Another process holds the ledger. Check for a second instance or container on the same volume. If the previous process crashed, start again once its heartbeat is 30 s old.

### Rotating secrets

- Rotating `SESSION_SECRET` logs every agent out. They sign in again automatically.
- Rotating `ADMIN_TOKEN` affects only operators.

## Backups

The ledger is a single SQLite file in WAL mode. Back it up while the gateway runs with `sqlite3 /data/odometer.db ".backup /backups/odometer-$(date +%F).db"` (or `Ledger.backup(path)` from code), or snapshot the volume. Balances are liabilities to agents, so treat this file like a financial record.

### Restoring

1. Stop the gateway. Replace the database file with the backup, and delete any `-wal` and `-shm` files next to it.
2. Start the gateway. Startup releases, uncharged, any request that was in flight when the backup was taken.
3. A top-up that was settling at backup time now shows as unresolved. Resolve it first, with verify and resolve; adjustments are refused until then.
4. Anything after the backup is missing from the ledger. Top-ups matter most, because agents paid real USDC. List the incoming transfers to the operator's token account since the backup time (an explorer, or `getSignaturesForAddress`). Credit each payment not in `GET /admin/topups` once, with a journaled adjustment that names its signature. Debits after the backup are lost revenue, not a loss to agents.
5. `GET /admin/readiness` should then show matching arithmetic, no unresolved top-ups, and custody covering liabilities.

Practice a restore before taking deposits.
