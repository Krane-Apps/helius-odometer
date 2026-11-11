import type { Context } from "hono";
import { sessionHeaders } from "../payments/paywall.js";
import type { AppDeps } from "../server/deps.js";
import { jsonResponse, rawJsonResponse, retryAfterUntilUtcMidnight } from "../server/http.js";
import { sha256Hex } from "../util/json.js";
import { microsToUsd, usdToMicros, type Micros } from "../util/money.js";

export interface RunResult {
  status: number;
  body: string;
  headers: Record<string, string>;
  /** Amount to debit (capped at the reserved price). */
  charged: Micros;
  /** Number of billable calls, for usage stats. */
  calls: number;
}

export interface MeteredArgs {
  requestId: string;
  tier: string;
  price: Micros;
  methods: string[];
  /** Parsed request body (passed to the x402 adapter). */
  body: unknown;
  /** Stable input for the idempotency request hash. */
  fingerprint: string;
  run: (wallet: string) => Promise<RunResult>;
}

const MAX_IDEMPOTENCY_KEY = 128;

/**
 * The shared spend path for every paid endpoint:
 * authorize (session, SIWx or top-up) -> rate limit -> idempotency ->
 * reserve the price -> run -> debit only what was served -> respond.
 */
export async function metered(c: Context, deps: AppDeps, args: MeteredArgs): Promise<Response> {
  const { ledger, paywall, payments } = deps;
  const base: Record<string, string> = { "x-odometer-request-id": args.requestId, "x-odometer-tier": args.tier };

  const maxPrice = c.req.header("x-odometer-max-price");
  if (maxPrice !== undefined) {
    let max: Micros;
    try {
      max = usdToMicros(maxPrice);
    } catch {
      return jsonResponse(c, 400, { error: "invalid_max_price", message: "X-Odometer-Max-Price must be a USD amount" }, base);
    }
    if (args.price > max) {
      return jsonResponse(
        c,
        409,
        {
          error: "price_exceeds_max",
          message: `This request costs $${microsToUsd(args.price)}, above your X-Odometer-Max-Price of $${microsToUsd(max)}. Not charged.`,
          priceUsd: microsToUsd(args.price),
        },
        base,
      );
    }
  }

  const idemKey = c.req.header("idempotency-key");
  if (idemKey !== undefined && (idemKey.length === 0 || idemKey.length > MAX_IDEMPOTENCY_KEY)) {
    return jsonResponse(c, 400, { error: "invalid_idempotency_key" }, base);
  }
  const requestHash = sha256Hex(`${args.tier}\n${args.fingerprint}`);
  const capRefusal = (wallet: string, block: { cap: Micros; spentToday: Micros }, headers: Record<string, string>) =>
    jsonResponse(
      c,
      429,
      {
        error: "daily_cap_exceeded",
        message: block.cap === 0 ? "Spending is stopped for this wallet; not charged" : "This wallet reached its daily spend cap; not charged",
        capUsd: microsToUsd(block.cap),
        spentTodayUsd: microsToUsd(block.spentToday),
      },
      { ...headers, "retry-after": retryAfterUntilUtcMidnight() },
    );

  const auth = await paywall.authorize(c, args.price, args.body, {
    // The wallet cannot pay for a new call. Two answers do not depend on that, and
    // neither should turn into a request for money:
    beforeChallenge: (wallet) => {
      const known = { ...base, "x-odometer-wallet": wallet };
      // 1. it already paid for this exact request: hand the stored response back;
      const stored = idemKey ? ledger.idempotencyPeek(wallet, idemKey, requestHash) : undefined;
      if (stored) {
        return rawJsonResponse(stored.status, stored.body, { ...stored.headers, ...known, "x-odometer-idempotent-replay": "true", "x-odometer-charged": "0" });
      }
      // 2. its spending cap rules the call out, so a deposit would not help.
      const block = ledger.dailyCapBlock(wallet, args.price);
      return block ? capRefusal(wallet, block, known) : undefined;
    },
  });
  if (auth.kind === "response") return auth.response;
  if (auth.kind === "respond") {
    if (auth.status === 402) deps.counters.challenges += 1;
    if (auth.isHtml) {
      const res = c.html(String(auth.body), auth.status as 402);
      for (const [k, v] of Object.entries({ ...base, ...auth.headers })) res.headers.set(k, v);
      return res;
    }
    return jsonResponse(c, auth.status, auth.body, { ...base, ...auth.headers });
  }
  const wallet = auth.wallet;
  const extra: Record<string, string> = { ...base, "x-odometer-wallet": wallet };
  if (auth.session) Object.assign(extra, sessionHeaders(auth.session));
  if (auth.paymentHeaders) Object.assign(extra, auth.paymentHeaders);
  if (auth.toppedUp) deps.counters.topups += 1;

  // A batch spends one rate-limit token per call, capped at the bucket size so it can always pass eventually.
  const limited = deps.walletLimiter.tryTake(wallet, Math.min(Math.max(1, args.methods.length), deps.walletLimiter.capacity));
  if (!limited.ok) {
    return jsonResponse(
      c,
      429,
      { error: "rate_limited", message: "Per-wallet request rate exceeded; not charged" },
      { ...extra, "retry-after": String(Math.max(1, Math.ceil(limited.retryAfterMs / 1000))) },
    );
  }

  if (idemKey) {
    const begin = ledger.idempotencyBegin(wallet, idemKey, requestHash);
    if (begin.state === "replay") {
      return rawJsonResponse(begin.status, begin.body, { ...begin.headers, ...extra, "x-odometer-idempotent-replay": "true", "x-odometer-charged": "0" });
    }
    if (begin.state === "in_flight") {
      return jsonResponse(c, 409, { error: "idempotency_in_flight", message: "A request with this Idempotency-Key is still running" }, extra);
    }
    if (begin.state === "mismatch") {
      return jsonResponse(c, 422, { error: "idempotency_mismatch", message: "Idempotency-Key was used with a different request" }, extra);
    }
  }
  const abortIdem = () => {
    if (idemKey) ledger.idempotencyAbort(wallet, idemKey);
  };

  if (args.price <= 0) {
    abortIdem();
    return jsonResponse(c, 400, { error: "nothing_to_charge" }, extra);
  }
  const reservation = ledger.reserve({
    wallet,
    amount: args.price,
    tier: args.tier,
    methods: args.methods,
    requestId: args.requestId,
  });
  if (!reservation.ok) {
    abortIdem();
    if (reservation.reason === "daily_cap_exceeded") {
      return jsonResponse(
        c,
        429,
        {
          error: "daily_cap_exceeded",
          message: "This wallet reached its daily spend cap; not charged",
          capUsd: microsToUsd(reservation.cap),
          spentTodayUsd: microsToUsd(reservation.spentToday),
        },
        { ...extra, "retry-after": retryAfterUntilUtcMidnight() },
      );
    }
    // A concurrent call spent the balance between authorization and reservation: challenge again.
    const result = await payments.process(c, args.body, {
      reason: "insufficient_balance",
      wallet,
      price: args.price,
      available: reservation.available,
    });
    if (result.type === "payment-error") {
      return jsonResponse(c, result.response.status, result.response.body ?? {}, { ...extra, ...result.response.headers });
    }
    return jsonResponse(c, 402, { error: "insufficient_balance" }, extra);
  }

  let outcome: RunResult;
  try {
    outcome = await args.run(wallet);
  } catch (err) {
    ledger.release(reservation.reservationId, idemKey ? { wallet, key: idemKey, requestId: args.requestId } : undefined);
    deps.logger.error("request failed", { requestId: args.requestId, error: err });
    return jsonResponse(c, 500, { error: "internal_error", requestId: args.requestId }, extra);
  }
  // The debit and the replay receipt commit together: a crash can no longer leave a
  // charged request whose stored response is missing.
  const storedHeaders = { ...outcome.headers, "x-odometer-request-id": args.requestId, "x-odometer-tier": args.tier };
  const fin = ledger.finalize(
    reservation.reservationId,
    outcome.charged,
    outcome.calls,
    idemKey
      ? outcome.status >= 500 && outcome.charged === 0
        ? { wallet, key: idemKey, requestId: args.requestId, abort: true }
        : { wallet, key: idemKey, requestId: args.requestId, status: outcome.status, headers: storedHeaders, body: outcome.body }
      : undefined,
  );
  deps.counters.revenueMicros += fin.charged;
  const headers: Record<string, string> = {
    ...outcome.headers,
    ...extra,
    "x-odometer-charged": String(fin.charged),
    "x-odometer-charged-usd": microsToUsd(fin.charged),
    "x-odometer-balance": String(fin.available),
    "x-odometer-balance-usd": microsToUsd(fin.available),
  };
  return rawJsonResponse(outcome.status, outcome.body, headers);
}
