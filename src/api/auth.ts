import type { Context } from "hono";
import type { IssuedSession } from "../payments/paywall.js";
import { bearerToken } from "../payments/session.js";
import type { AppDeps } from "../server/deps.js";

export type WalletAuth =
  | { ok: true; wallet: string; session?: IssuedSession }
  | { ok: false; status: number; body: Record<string, unknown> };

/** Identifies the wallet on free endpoints: session token or SIWx proof (never payment). */
export async function resolveWallet(c: Context, deps: AppDeps): Promise<WalletAuth> {
  const token = bearerToken(c.req.header("authorization"));
  if (token) {
    const v = deps.sessions.verify(token);
    if (v.ok) return { ok: true, wallet: v.wallet };
    return { ok: false, status: 401, body: { error: "session_invalid", reason: v.reason, challengeUrl: challengeUrl(deps) } };
  }
  const siwx = c.req.header("sign-in-with-x");
  if (siwx) {
    const v = await deps.siwx.verifyHeader(siwx);
    if (v.ok) return { ok: true, wallet: v.wallet, session: deps.sessions.issue(v.wallet) };
    return { ok: false, status: 401, body: { error: v.reason, message: v.message, challengeUrl: challengeUrl(deps) } };
  }
  return {
    ok: false,
    status: 401,
    body: {
      error: "authentication_required",
      message: "Send `Authorization: Bearer <X-Odometer-Session token>` or a SIGN-IN-WITH-X proof",
      challengeUrl: challengeUrl(deps),
    },
  };
}

function challengeUrl(deps: AppDeps): string {
  return `${deps.config.publicOrigin}/v1/auth/challenge`;
}
