import {
  buildSIWxSchema,
  parseSIWxHeader,
  validateSIWxMessage,
  verifySIWxSignature,
  type SIWxExtension,
} from "@x402/extensions/sign-in-with-x";
import { randomHex } from "../util/ids.js";

export type SiwxResult = { ok: true; wallet: string; nonce: string } | { ok: false; reason: string; message: string };

export interface SiwxOptions {
  /** Public browser-visible origin, e.g. https://odometer.example.com (no path). */
  origin: string;
  network: string;
  statement: string;
  /** Lifetime of challenges this server issues. */
  expirationSeconds: number;
  /** Atomically records a nonce; returns false if it was already used. */
  useNonce: (nonce: string, expiresAt: number) => boolean;
  now?: () => number;
}

const MAX_AGE_MS = 5 * 60_000;

/**
 * Sign-In-With-X (CAIP-122 / SIWS) for Solana wallets. Proofs are bound to
 * the configured origin (never the Host header), verified with ed25519, and
 * every nonce is single-use, as the x402 SIWx spec requires.
 */
export class SiwxAuth {
  readonly origin: URL;

  constructor(private readonly opts: SiwxOptions) {
    const url = new URL(opts.origin);
    if (url.pathname !== "/" || url.search || url.hash) throw new Error("SIWx origin must not include a path");
    this.origin = url;
  }

  /** A fresh challenge in the same shape as the `sign-in-with-x` 402 extension. */
  challenge(path: string): SIWxExtension {
    const now = this.opts.now?.() ?? Date.now();
    const uri = new URL(path, this.origin).toString();
    return {
      info: {
        domain: this.origin.host,
        uri,
        version: "1",
        nonce: randomHex(16),
        issuedAt: new Date(now).toISOString(),
        expirationTime: new Date(now + this.opts.expirationSeconds * 1000).toISOString(),
        statement: this.opts.statement,
        resources: [uri],
      },
      supportedChains: [{ chainId: this.opts.network, type: "ed25519" }],
      schema: buildSIWxSchema(),
    };
  }

  async verifyHeader(header: string): Promise<SiwxResult> {
    let payload;
    try {
      payload = parseSIWxHeader(header);
    } catch (err) {
      return { ok: false, reason: "invalid_siwx_header", message: err instanceof Error ? err.message : "unparseable" };
    }
    if (payload.chainId !== this.opts.network) {
      return { ok: false, reason: "invalid_siwx_chain_id", message: `expected chain ${this.opts.network}` };
    }
    const validation = await validateSIWxMessage(payload, this.origin, { maxAge: MAX_AGE_MS });
    if (!validation.isValid) return { ok: false, reason: validation.invalidReason, message: validation.invalidMessage };
    const verification = await verifySIWxSignature(payload);
    if (!verification.isValid) return { ok: false, reason: verification.invalidReason, message: verification.invalidMessage };
    const issued = Date.parse(payload.issuedAt);
    const expires = payload.expirationTime ? Date.parse(payload.expirationTime) : issued + MAX_AGE_MS;
    if (!this.opts.useNonce(payload.nonce, Math.max(expires, issued + MAX_AGE_MS) + 60_000)) {
      return { ok: false, reason: "invalid_siwx_nonce", message: "nonce already used" };
    }
    return { ok: true, wallet: verification.payer, nonce: payload.nonce };
  }
}
