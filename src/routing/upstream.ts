import type { UpstreamConfig } from "../config.js";
import { TokenBucket } from "../util/token-bucket.js";
import { looksRateLimited, type JsonRpcResponse } from "./jsonrpc.js";

export type UpstreamKind = "public" | "helius" | "sender";

export type CallOutcome =
  | { kind: "ok"; status: number; body: JsonRpcResponse; latencyMs: number }
  | { kind: "rate-limited"; status: number; latencyMs: number; retryAfterMs: number }
  | { kind: "http-error"; status: number; latencyMs: number; error: string }
  | { kind: "timeout"; latencyMs: number }
  | { kind: "network-error"; latencyMs: number; error: string }
  | { kind: "bad-response"; status: number; latencyMs: number; error: string };

export interface UpstreamSnapshot {
  id: string;
  kind: UpstreamKind;
  available: boolean;
  ejected: boolean;
  cooling: boolean;
  lastSlot?: number;
  lastSlotAgeMs?: number;
  slotLag?: number;
  ewmaLatencyMs: number;
  requests: number;
  failures: number;
  rateLimited: number;
  consecutiveFailures: number;
}

const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

/** One JSON-RPC endpoint with its own rate limit and health state. */
export class Upstream {
  readonly id: string;
  readonly url: string;
  readonly kind: UpstreamKind;
  readonly weight: number;
  readonly bucket: TokenBucket;
  readonly denyMethods: Set<string>;
  /** Extra per-method-group buckets (e.g. Helius sendTransaction and DAS limits). */
  readonly groupBuckets = new Map<string, TokenBucket>();

  lastSlot?: number;
  lastSlotAt = 0;
  ewmaLatencyMs = 250;
  consecutiveFailures = 0;
  probeSuccesses = 0;
  ejectedUntil = 0;
  ejections = 0;
  coolingUntil = 0;
  requests = 0;
  failures = 0;
  rateLimited = 0;

  constructor(
    cfg: Pick<UpstreamConfig, "id" | "url" | "rps" | "denyMethods" | "weight"> & { kind: UpstreamKind },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.id = cfg.id;
    this.url = cfg.url;
    this.kind = cfg.kind;
    this.weight = cfg.weight;
    this.bucket = new TokenBucket(cfg.rps, Math.max(1, Math.ceil(cfg.rps * 2)));
    this.denyMethods = new Set(cfg.denyMethods);
  }

  isEjected(now = Date.now()): boolean {
    return this.ejectedUntil > now;
  }

  isCooling(now = Date.now()): boolean {
    return this.coolingUntil > now;
  }

  isAvailable(now = Date.now()): boolean {
    return !this.isEjected(now) && !this.isCooling(now);
  }

  serves(method: string): boolean {
    return !this.denyMethods.has(method);
  }

  /** Takes a rate-limit token from the main bucket and an optional group bucket. */
  tryTake(group?: string, now = Date.now()): boolean {
    const g = group ? this.groupBuckets.get(group) : undefined;
    if (g && g.available(now) < 1) return false;
    if (!this.bucket.tryTake(1, now)) return false;
    if (g) g.tryTake(1, now);
    return true;
  }

  waitMs(group?: string, now = Date.now()): number {
    const g = group ? this.groupBuckets.get(group) : undefined;
    return Math.max(this.bucket.waitMs(1, now), g ? g.waitMs(1, now) : 0);
  }

  observeSlot(slot: number, now = Date.now()): void {
    if (!Number.isSafeInteger(slot) || slot < 0) return;
    if (this.lastSlot === undefined || slot >= this.lastSlot || now - this.lastSlotAt > 10_000) {
      this.lastSlot = slot;
      this.lastSlotAt = now;
    }
  }

  noteSuccess(latencyMs: number, now = Date.now()): void {
    this.ewmaLatencyMs = this.ewmaLatencyMs * 0.8 + latencyMs * 0.2;
    this.consecutiveFailures = 0;
    if (this.ejectedUntil > 0) {
      this.probeSuccesses += 1;
      if (this.probeSuccesses >= 2) {
        this.ejectedUntil = 0;
        this.probeSuccesses = 0;
        this.ejections = 0;
      }
    }
    void now;
  }

  noteFailure(now = Date.now(), ejectAfter = 3): void {
    this.failures += 1;
    this.consecutiveFailures += 1;
    this.probeSuccesses = 0;
    if (this.consecutiveFailures >= ejectAfter) {
      this.ejections += 1;
      const backoff = Math.min(60_000, 5_000 * 2 ** Math.min(this.ejections - 1, 4));
      this.ejectedUntil = now + backoff;
      this.consecutiveFailures = 0;
    }
  }

  noteRateLimited(retryAfterMs: number, now = Date.now()): void {
    this.rateLimited += 1;
    this.coolingUntil = Math.max(this.coolingUntil, now + retryAfterMs);
  }

  /** Sends one JSON-RPC request. Never throws. */
  async call(payload: unknown, timeoutMs: number, url = this.url): Promise<CallOutcome> {
    this.requests += 1;
    const started = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
    try {
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (res.status === 429) {
        const latencyMs = performance.now() - started;
        await res.body?.cancel().catch(() => {});
        return { kind: "rate-limited", status: 429, latencyMs, retryAfterMs: parseRetryAfter(res.headers.get("retry-after")) };
      }
      const text = await readCapped(res, MAX_RESPONSE_BYTES);
      const latencyMs = performance.now() - started;
      // 401/402/403 mean the provider rejected this gateway's key or plan, even when the
      // body is JSON-RPC shaped: an upstream failure, retried elsewhere and never billed.
      const rejected = res.status === 401 || res.status === 402 || res.status === 403;
      if (rejected || res.status >= 500 || (res.status >= 400 && !text.trimStart().startsWith("{"))) {
        return { kind: "http-error", status: res.status, latencyMs, error: text.slice(0, 200) };
      }
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return { kind: "bad-response", status: res.status, latencyMs, error: "invalid JSON" };
      }
      if (!body || typeof body !== "object" || Array.isArray(body) || (!("result" in body) && !("error" in body))) {
        return { kind: "bad-response", status: res.status, latencyMs, error: "not a JSON-RPC response" };
      }
      const rpc = body as JsonRpcResponse;
      if ("error" in rpc && rpc.error && looksRateLimited(rpc.error)) {
        return { kind: "rate-limited", status: res.status, latencyMs, retryAfterMs: 10_000 };
      }
      return { kind: "ok", status: res.status, body: rpc, latencyMs };
    } catch (err) {
      const latencyMs = performance.now() - started;
      if (controller.signal.aborted) return { kind: "timeout", latencyMs };
      return { kind: "network-error", latencyMs, error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  }

  snapshot(bestSlot: number | undefined, now = Date.now()): UpstreamSnapshot {
    return {
      id: this.id,
      kind: this.kind,
      available: this.isAvailable(now),
      ejected: this.isEjected(now),
      cooling: this.isCooling(now),
      lastSlot: this.lastSlot,
      lastSlotAgeMs: this.lastSlot === undefined ? undefined : now - this.lastSlotAt,
      slotLag: this.lastSlot !== undefined && bestSlot !== undefined ? Math.max(0, bestSlot - this.lastSlot) : undefined,
      ewmaLatencyMs: Math.round(this.ewmaLatencyMs),
      requests: this.requests,
      failures: this.failures,
      rateLimited: this.rateLimited,
      consecutiveFailures: this.consecutiveFailures,
    };
  }
}

export function parseRetryAfter(value: string | null, fallbackMs = 10_000): number {
  if (!value) return fallbackMs;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(300_000, Math.max(1000, seconds * 1000));
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.min(300_000, Math.max(1000, date - Date.now()));
  return fallbackMs;
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`upstream response larger than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
