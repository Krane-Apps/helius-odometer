import { createHmac, timingSafeEqual } from "node:crypto";

export interface SessionClaims {
  v: 1;
  /** wallet address */
  w: string;
  /** session epoch at issue time (bumping the account epoch revokes older tokens) */
  e: number;
  iat: number;
  exp: number;
}

export type SessionVerify =
  | { ok: true; wallet: string; claims: SessionClaims }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" | "revoked" };

const PREFIX = "odo1";

/**
 * Short-lived bearer session tokens issued after a wallet proves control
 * (SIWx) or pays a top-up. They let an agent make many calls without a
 * 402 round trip each time. HMAC-signed, stateless, revocable per wallet.
 */
export class SessionManager {
  private readonly key: Buffer;

  constructor(
    secret: string,
    readonly ttlSeconds: number,
    private readonly epochOf: (wallet: string) => number,
    private readonly now: () => number = Date.now,
  ) {
    this.key = createHmac("sha256", secret).update("helius-odometer/session/v1").digest();
  }

  issue(wallet: string): { token: string; expiresAt: number } {
    const iat = Math.floor(this.now() / 1000);
    const claims: SessionClaims = { v: 1, w: wallet, e: this.epochOf(wallet), iat, exp: iat + this.ttlSeconds };
    const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return { token: `${PREFIX}.${body}.${this.sign(body)}`, expiresAt: claims.exp * 1000 };
  }

  verify(token: string): SessionVerify {
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== PREFIX) return { ok: false, reason: "malformed" };
    const [, body, sig] = parts as [string, string, string];
    const expected = Buffer.from(this.sign(body));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: "bad_signature" };
    let claims: SessionClaims;
    try {
      claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionClaims;
    } catch {
      return { ok: false, reason: "malformed" };
    }
    if (claims.v !== 1 || typeof claims.w !== "string" || typeof claims.exp !== "number") return { ok: false, reason: "malformed" };
    if (claims.exp * 1000 <= this.now()) return { ok: false, reason: "expired" };
    if (claims.e !== this.epochOf(claims.w)) return { ok: false, reason: "revoked" };
    return { ok: true, wallet: claims.w, claims };
  }

  private sign(body: string): string {
    return createHmac("sha256", this.key).update(body).digest("base64url");
  }
}

export function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m?.[1];
}
