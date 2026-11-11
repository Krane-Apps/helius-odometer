import type { Context } from "hono";
import type { Ledger } from "../ledger/ledger.js";
import type { Logger } from "../util/log.js";
import type { KeyedRateLimiter } from "../util/token-bucket.js";
import { sha256Hex } from "../util/json.js";
import type { Micros } from "../util/money.js";
import { bearerToken, type SessionManager } from "./session.js";
import type { SiwxAuth } from "./siwx.js";
import type { ChallengeContext, Payments } from "./x402.js";

export interface IssuedSession {
  token: string;
  expiresAt: number;
}

export type AuthResult =
  | {
      kind: "ok";
      wallet: string;
      via: "session" | "siwx" | "payment";
      session?: IssuedSession;
      /** PAYMENT-RESPONSE (and cache) headers when a top-up settled on this request. */
      paymentHeaders?: Record<string, string>;
      toppedUp?: { txSignature: string; amountAtomic: string };
    }
  | { kind: "respond"; status: number; headers: Record<string, string>; body: unknown; isHtml?: boolean }
  /** A finished response from `beforeChallenge`, returned as is. */
  | { kind: "response"; response: Response };

export interface AuthorizeOptions {
  /**
   * Runs when the wallet is known but cannot pay, before a top-up is requested.
   * A returned response replaces the 402: use it for answers a deposit would
   * not change (a stored replay, a spending cap).
   */
  beforeChallenge?: (wallet: string) => Response | undefined;
}

export interface PaywallDeps {
  payments: Payments;
  ledger: Ledger;
  sessions: SessionManager;
  siwx: SiwxAuth;
  logger: Logger;
  clientIp: (c: Context) => string;
  /** Limits 402 challenges per client IP. */
  challengeLimiter?: KeyedRateLimiter;
}

/** Re-issue a session when it has less than this left. */
const RENEW_WITHIN_MS = 5 * 60_000;

/**
 * Decides who is calling and whether they can pay for `price`:
 *  1. a PAYMENT-SIGNATURE header settles a top-up first (upfront flow), then serves
 *  2. a session token or SIWx proof identifies the wallet; enough balance means serve
 *  3. otherwise answer 402 with top-up options and a SIWx challenge
 */
export class Paywall {
  constructor(private readonly deps: PaywallDeps) {}

  async authorize(c: Context, price: Micros, body: unknown, opts: AuthorizeOptions = {}): Promise<AuthResult> {
    const { payments, ledger, sessions, siwx, logger } = this.deps;
    const paymentHeader = c.req.header("payment-signature") ?? c.req.header("x-payment");

    if (paymentHeader) return this.settleTopup(c, body);

    let wallet: string | undefined;
    let via: "session" | "siwx" | undefined;
    let session: IssuedSession | undefined;
    const challenge: ChallengeContext = { reason: "payment_required", price };

    const token = bearerToken(c.req.header("authorization"));
    if (token) {
      const v = sessions.verify(token);
      if (v.ok) {
        wallet = v.wallet;
        via = "session";
        if (v.claims.exp * 1000 - Date.now() < RENEW_WITHIN_MS) session = sessions.issue(wallet);
      } else {
        challenge.reason = "session_invalid";
        challenge.detail = v.reason;
      }
    }
    const siwxHeader = c.req.header("sign-in-with-x");
    if (!wallet && siwxHeader) {
      const v = await siwx.verifyHeader(siwxHeader);
      if (v.ok) {
        wallet = v.wallet;
        via = "siwx";
        session = sessions.issue(wallet);
        ledger.recordEvent("siwx", wallet);
      } else {
        challenge.detail = `${v.reason}: ${v.message}`;
      }
    }

    if (wallet && via) {
      const account = ledger.getAccount(wallet);
      const available = account?.available ?? 0;
      if (available >= price) return { kind: "ok", wallet, via, session };
      const early = opts.beforeChallenge?.(wallet);
      if (early) {
        if (session) for (const [k, v] of Object.entries(sessionHeaders(session))) early.headers.set(k, v);
        return { kind: "response", response: early };
      }
      challenge.reason = "insufficient_balance";
      challenge.wallet = wallet;
      challenge.available = available;
    }

    const limited = this.deps.challengeLimiter?.tryTake(this.deps.clientIp(c));
    if (limited && !limited.ok) {
      return {
        kind: "respond",
        status: 429,
        headers: { "retry-after": String(Math.max(1, Math.ceil(limited.retryAfterMs / 1000))) },
        body: { error: "rate_limited", message: "Too many payment challenges from this address; not charged" },
      };
    }
    if (!payments.initialized) {
      try {
        await withTimeout(payments.initialize(), 5000);
      } catch (err) {
        logger.warn("payments unavailable", { error: err instanceof Error ? err.message : String(err) });
        return {
          kind: "respond",
          status: 503,
          headers: { "retry-after": "10" },
          body: {
            error: "payments_unavailable",
            message: "The payment facilitator is unreachable; funded wallets can still make calls. Retry shortly.",
          },
        };
      }
    }
    const result = await payments.process(c, body, challenge);
    if (result.type === "payment-error") {
      ledger.recordEvent("challenge", wallet ?? null, sha256Hex(this.deps.clientIp(c)).slice(0, 16));
      const headers = { ...result.response.headers };
      if (session) Object.assign(headers, sessionHeaders(session));
      return {
        kind: "respond",
        status: result.response.status,
        headers,
        body: result.response.body ?? {},
        isHtml: result.response.isHtml,
      };
    }
    // Paid routes always answer 402 without a payment header; anything else is a configuration error.
    logger.error("unexpected payment state without payment header", { type: result.type, path: c.req.path });
    return { kind: "respond", status: 500, headers: {}, body: { error: "payment_configuration_error" } };
  }

  private async settleTopup(c: Context, body: unknown): Promise<AuthResult> {
    const { payments, sessions, logger } = this.deps;
    if (!payments.initialized) {
      try {
        await withTimeout(payments.initialize(), 5000);
      } catch {
        return {
          kind: "respond",
          status: 503,
          headers: { "retry-after": "10" },
          body: { error: "payments_unavailable", message: "The payment facilitator is unreachable. Retry shortly." },
        };
      }
    }
    let result;
    try {
      result = await payments.process(c, body, { reason: "payment_required" });
    } catch (err) {
      // The SDK rethrows facilitator transport errors (e.g. a settle timeout). The settlement
      // hook has already frozen the top-up for review if funds may have moved.
      logger.warn("settlement request failed", { error: err instanceof Error ? err.message : String(err) });
      return {
        kind: "respond",
        status: 502,
        headers: {},
        body: {
          error: "settlement_unknown",
          message: "The payment may or may not have settled. It is under review and will be credited if it landed; do not resend it.",
        },
      };
    }
    if (result.type === "payment-verified") {
      const settlement = result.beforeHandlerSettlement;
      const payer = settlement?.result.payer;
      if (!settlement || !settlement.result.success || !payer) {
        logger.error("top-up verified without a completed upfront settlement", { path: c.req.path });
        return { kind: "respond", status: 500, headers: {}, body: { error: "settlement_incomplete" } };
      }
      const session = sessions.issue(payer);
      return {
        kind: "ok",
        wallet: payer,
        via: "payment",
        session,
        paymentHeaders: payments.httpServer.createCompletedSettlementHeaders(settlement),
        toppedUp: { txSignature: settlement.result.transaction, amountAtomic: settlement.result.amount ?? settlement.requirements.amount },
      };
    }
    // Failure bookkeeping lives in the settlement hooks, which know whether this request
    // owned the attempt; marking here could clobber a concurrent settlement of the same payload.
    if (result.type === "payment-error") {
      return {
        kind: "respond",
        status: result.response.status,
        headers: result.response.headers,
        body: result.response.body ?? {},
        isHtml: result.response.isHtml,
      };
    }
    return { kind: "respond", status: 500, headers: {}, body: { error: "payment_configuration_error" } };
  }
}

export function sessionHeaders(session: IssuedSession): Record<string, string> {
  return {
    "x-odometer-session": session.token,
    "x-odometer-session-expires": new Date(session.expiresAt).toISOString(),
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
