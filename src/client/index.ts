import type { KeyPairSigner, RpcTransport } from "@solana/kit";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { decodePaymentResponseHeader } from "@x402/core/http";
import type { Network, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { createSIWxPayload, encodeSIWxHeader, type SIWxExtension } from "@x402/extensions/sign-in-with-x";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { toSiwxSigner } from "./signer.js";

export { toSiwxSigner } from "./signer.js";

export type Tier = "economy" | "standard" | "fast";

export interface OdometerClientOptions {
  /** Gateway origin, e.g. https://odometer.example.com */
  baseUrl: string;
  /** The agent's wallet. It signs SIWx proofs and USDC top-up transfers; it never leaves the process. */
  signer: KeyPairSigner;
  /** Default tier for calls. Ask your user how important speed is. */
  tier?: Tier;
  /** Pay top-ups automatically when the balance runs out (default true). */
  autoTopup?: boolean;
  /** Preferred top-up denomination in USD (default: the smallest the gateway offers). */
  topupUsd?: number;
  /** Refuse any single top-up above this (default $5). */
  maxTopupUsd?: number;
  /** Refuse further top-ups once this client has paid this much in total (default $20). */
  maxSpendUsd?: number;
  /** RPC used to build payment transactions (default: the gateway's free /v1/bootstrap). */
  paymentRpcUrl?: string;
  /**
   * Payment assets this client may pay in besides the well-known USDC mints the x402 SDK
   * recognizes (e.g. a test mint on a local validator). Leave unset in production.
   */
  allowedAssets?: Array<{ network: string; asset: string; maxAmountPerPayment?: string }>;
  fetch?: typeof fetch;
}

export interface CallMeta {
  status: number;
  requestId?: string;
  tier?: string;
  chargedMicros: number;
  balanceMicros?: number;
  upstream?: string;
  upstreamClass?: string;
  escalated?: boolean;
  contextSlot?: number;
  latencyMs?: number;
  /** Set when this call paid a top-up on-chain. */
  topup?: { transaction: string; payer?: string; amountAtomic?: string };
}

export interface JsonRpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

export interface RpcResult<T> {
  result?: T;
  error?: JsonRpcErrorShape;
  meta: CallMeta;
}

export class OdometerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "OdometerError";
  }
}

const USD = 1_000_000;

/**
 * Client for Helius Odometer. Signs in once with SIWx, reuses the session
 * token for every call (one round trip per call), and pays a USDC top-up via
 * x402 only when the prepaid balance runs out, within the configured limits.
 */
export class OdometerClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly payer: x402Client;
  private readonly http: x402HTTPClient;
  private session?: { token: string; expiresAt: number };
  private signingIn?: Promise<void>;
  /** Total paid in top-ups by this client instance, in micros. */
  spentOnTopupsMicros = 0;

  constructor(readonly opts: OdometerClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
    this.payer = new x402Client()
      .register(
        "solana:*",
        new ExactSvmScheme(opts.signer, { rpcUrl: opts.paymentRpcUrl ?? `${this.baseUrl}/v1/bootstrap`, transactionVersions: [0] }),
      )
      // The SDK's own guard rails: only known assets (plus explicit opt-ins), capped per payment.
      .setSpendControls({
        maxAmountPerPayment: `$${opts.maxTopupUsd ?? 5}`,
        ...(opts.allowedAssets?.length
          ? { allowedAssets: opts.allowedAssets.map((a) => ({ ...a, network: a.network as Network })) }
          : {}),
      });
    this.http = new x402HTTPClient(this.payer);
  }

  get wallet(): string {
    return this.opts.signer.address;
  }

  get sessionToken(): string | undefined {
    return this.session && this.session.expiresAt - Date.now() > 30_000 ? this.session.token : undefined;
  }

  /** Proves wallet control with SIWx and stores a session token. */
  async signIn(): Promise<{ wallet: string; availableMicros: number }> {
    const challengeRes = await this.fetchImpl(`${this.baseUrl}/v1/auth/challenge`);
    if (!challengeRes.ok) throw new OdometerError("challenge_failed", `challenge request failed: ${challengeRes.status}`);
    const challenge = (await challengeRes.json()) as SIWxExtension;
    const chain = challenge.supportedChains.find((c) => c.chainId.startsWith("solana:"));
    if (!chain) throw new OdometerError("unsupported_chain", "gateway offers no Solana SIWx chain");
    const url = `${this.baseUrl}/v1/auth/session`;
    const payload = await createSIWxPayload({ ...challenge.info, chainId: chain.chainId, type: chain.type }, toSiwxSigner(this.opts.signer), url);
    const res = await this.fetchImpl(url, { method: "POST", headers: { "sign-in-with-x": encodeSIWxHeader(payload) } });
    const body = (await res.json()) as { sessionToken?: string; expiresAt?: string; availableMicros?: number; error?: string; message?: string };
    if (!res.ok || !body.sessionToken) throw new OdometerError(body.error ?? "sign_in_failed", body.message ?? `sign-in failed: ${res.status}`);
    this.session = { token: body.sessionToken, expiresAt: Date.parse(body.expiresAt ?? "") || Date.now() + 600_000 };
    return { wallet: this.wallet, availableMicros: body.availableMicros ?? 0 };
  }

  private async ensureSession(): Promise<void> {
    if (this.sessionToken) return;
    if (!this.signingIn) {
      this.signingIn = this.signIn()
        .then(() => undefined)
        .finally(() => {
          this.signingIn = undefined;
        });
    }
    await this.signingIn;
  }

  /** One JSON-RPC call. Errors from Solana come back in `error`; payment problems throw OdometerError. */
  async rpc<T = unknown>(
    method: string,
    params?: unknown,
    opts: { tier?: Tier; maxPriceUsd?: number; idempotencyKey?: string; signal?: AbortSignal } = {},
  ): Promise<RpcResult<T>> {
    const body = { jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) };
    const { status, json, meta } = await this.send(opts.tier ?? this.opts.tier ?? "standard", body, opts);
    const r = json as { result?: T; error?: JsonRpcErrorShape } | undefined;
    if (!r || (r.result === undefined && r.error === undefined)) {
      throw new OdometerError("unexpected_response", `unexpected response (${status})`, json);
    }
    return { result: r.result, error: r.error, meta };
  }

  /** A JSON-RPC batch; returns responses in request order. */
  async batch(
    calls: Array<{ method: string; params?: unknown }>,
    opts: { tier?: Tier; maxPriceUsd?: number; idempotencyKey?: string } = {},
  ): Promise<{ responses: Array<{ result?: unknown; error?: JsonRpcErrorShape }>; meta: CallMeta }> {
    const body = calls.map((c, i) => ({ jsonrpc: "2.0", id: i, method: c.method, ...(c.params === undefined ? {} : { params: c.params }) }));
    const { json, meta } = await this.send(opts.tier ?? this.opts.tier ?? "standard", body, opts);
    if (!Array.isArray(json)) throw new OdometerError("unexpected_response", "expected a batch response", json);
    return { responses: json as Array<{ result?: unknown; error?: JsonRpcErrorShape }>, meta };
  }

  /** Current balance and limits for this wallet. */
  async balance(): Promise<Record<string, unknown>> {
    await this.ensureSession();
    const res = await this.fetchImpl(`${this.baseUrl}/v1/balance`, { headers: { authorization: `Bearer ${this.sessionToken}` } });
    return (await res.json()) as Record<string, unknown>;
  }

  /** Pays a top-up now (without making a call). */
  async topup(usd?: number): Promise<Record<string, unknown>> {
    const first = await this.fetchImpl(`${this.baseUrl}/v1/topup`, { method: "POST" });
    if (first.status !== 402) throw new OdometerError("unexpected_response", `expected 402, got ${first.status}`);
    const pr = this.readPaymentRequired(first, await first.json().catch(() => undefined));
    const headers = await this.paymentHeaders(pr, usd);
    const res = await this.fetchImpl(`${this.baseUrl}/v1/topup`, { method: "POST", headers });
    const body = (await res.json()) as Record<string, unknown>;
    this.captureSession(res);
    if (!res.ok) throw new OdometerError(String(body.error ?? "topup_failed"), `top-up failed: ${res.status}`, body);
    return body;
  }

  /** Low-level send with sign-in, session reuse and automatic top-up. */
  async send(
    tier: Tier,
    body: unknown,
    opts: { maxPriceUsd?: number; idempotencyKey?: string; signal?: AbortSignal } = {},
  ): Promise<{ status: number; json: unknown; meta: CallMeta }> {
    await this.ensureSession();
    const url = `${this.baseUrl}/v1/rpc/${tier}`;
    const text = JSON.stringify(body);
    const base: Record<string, string> = { "content-type": "application/json" };
    if (opts.maxPriceUsd !== undefined) base["x-odometer-max-price"] = String(opts.maxPriceUsd);
    if (opts.idempotencyKey) base["idempotency-key"] = opts.idempotencyKey;

    const post = (extra: Record<string, string>) =>
      this.fetchImpl(url, { method: "POST", headers: { ...base, ...extra }, body: text, signal: opts.signal });
    const withSession = (): Record<string, string> => (this.sessionToken ? { authorization: `Bearer ${this.sessionToken}` } : {});

    let res = await post(withSession());
    let parsed = await readJson(res);
    if (res.status === 402) {
      const err = parsed as { error?: string } | undefined;
      if (err?.error === "session_invalid") {
        this.session = undefined;
        await this.ensureSession();
        res = await post(withSession());
        parsed = await readJson(res);
      }
    }
    if (res.status === 402) {
      const err = parsed as { error?: string; message?: string } | undefined;
      if (err?.error === "daily_cap_exceeded") throw new OdometerError("daily_cap_exceeded", err.message ?? "daily cap reached", parsed);
      if (this.opts.autoTopup === false) {
        throw new OdometerError(err?.error ?? "payment_required", err?.message ?? "payment required", parsed);
      }
      const pr = this.readPaymentRequired(res, parsed);
      const payment = await this.paymentHeaders(pr, this.opts.topupUsd);
      res = await post({ ...withSession(), ...payment });
      parsed = await readJson(res);
    }
    this.captureSession(res);
    if (res.status === 402) {
      const err = parsed as { error?: string; message?: string } | undefined;
      throw new OdometerError(err?.error ?? "payment_failed", err?.message ?? "payment was not accepted", parsed);
    }
    const errBody = parsed as { error?: unknown; message?: string } | undefined;
    if (res.status >= 400 && typeof errBody?.error === "string") {
      // Gateway-level refusals (max price, rate limits, caps, outages) are not JSON-RPC results.
      throw new OdometerError(errBody.error, errBody.message ?? `request failed (${res.status})`, parsed);
    }
    return { status: res.status, json: parsed, meta: readMeta(res) };
  }

  /** A @solana/kit transport, so `createSolanaRpcFromTransport(client.transport("economy"))` just works. */
  transport(tier?: Tier): RpcTransport {
    return (async ({ payload, signal }: { payload: unknown; signal?: AbortSignal }) => {
      const { json } = await this.send(tier ?? this.opts.tier ?? "standard", payload, { signal });
      return json;
    }) as RpcTransport;
  }

  private readPaymentRequired(res: Response, body: unknown): PaymentRequired {
    try {
      return this.http.getPaymentRequiredResponse((n) => res.headers.get(n), body);
    } catch (err) {
      throw new OdometerError("bad_payment_required", `could not read payment requirements: ${String(err)}`);
    }
  }

  private chooseRequirement(pr: PaymentRequired, preferredUsd?: number): PaymentRequirements {
    const options = pr.accepts.filter((a) => a.scheme === "exact" && a.network.startsWith("solana:"));
    if (options.length === 0) throw new OdometerError("no_payment_option", "gateway offers no Solana exact payment option");
    const usd = (a: PaymentRequirements) => Number(a.amount) / 10 ** 6;
    const sorted = [...options].sort((a, b) => Number(a.amount) - Number(b.amount));
    const chosen = (preferredUsd !== undefined && sorted.find((a) => Math.abs(usd(a) - preferredUsd) < 1e-9)) || sorted[0]!;
    const maxTopup = this.opts.maxTopupUsd ?? 5;
    if (usd(chosen) > maxTopup) {
      throw new OdometerError("topup_over_limit", `top-up of $${usd(chosen)} exceeds maxTopupUsd $${maxTopup}`);
    }
    const maxSpend = (this.opts.maxSpendUsd ?? 20) * USD;
    if (this.spentOnTopupsMicros + Number(chosen.amount) > maxSpend) {
      throw new OdometerError("spend_limit_reached", `top-ups would exceed maxSpendUsd $${maxSpend / USD}`);
    }
    return chosen;
  }

  private async paymentHeaders(pr: PaymentRequired, preferredUsd?: number): Promise<Record<string, string>> {
    const chosen = this.chooseRequirement(pr, preferredUsd);
    const payload = await this.payer.createPaymentPayload({ ...pr, accepts: [chosen] });
    this.spentOnTopupsMicros += Number(chosen.amount);
    return this.http.encodePaymentSignatureHeader(payload);
  }

  private captureSession(res: Response): void {
    const token = res.headers.get("x-odometer-session");
    if (token) {
      const exp = Date.parse(res.headers.get("x-odometer-session-expires") ?? "");
      this.session = { token, expiresAt: Number.isFinite(exp) ? exp : Date.now() + 600_000 };
    }
  }
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function readMeta(res: Response): CallMeta {
  const num = (n: string) => {
    const v = res.headers.get(n);
    return v === null || v === "" ? undefined : Number(v);
  };
  const paymentHeader = res.headers.get("payment-response");
  let topup: CallMeta["topup"];
  if (paymentHeader) {
    try {
      const s = decodePaymentResponseHeader(paymentHeader);
      if (s.success) topup = { transaction: s.transaction, payer: s.payer, amountAtomic: s.amount };
    } catch {
      topup = undefined;
    }
  }
  return {
    status: res.status,
    requestId: res.headers.get("x-odometer-request-id") ?? undefined,
    tier: res.headers.get("x-odometer-tier") ?? undefined,
    chargedMicros: num("x-odometer-charged") ?? 0,
    balanceMicros: num("x-odometer-balance"),
    upstream: res.headers.get("x-odometer-upstream") ?? undefined,
    upstreamClass: res.headers.get("x-odometer-upstream-class") ?? undefined,
    escalated: res.headers.get("x-odometer-escalated")?.split(",").includes("true"),
    contextSlot: num("x-odometer-context-slot"),
    latencyMs: num("x-odometer-latency-ms"),
    topup,
  };
}

export type { Network };
