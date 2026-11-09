import type { Commitment, MethodSpec } from "../pricing/methods.js";
import type { QuoteItem, Tier } from "../pricing/pricing.js";
import { canonicalJson } from "../util/json.js";
import type { Logger } from "../util/log.js";
import type { LruCache } from "../util/lru.js";
import {
  prepareParams,
  responseSlot,
  TX_FOLLOWUP_METHODS,
  type SlotHighWaterMarks,
  type TxSessions,
} from "./consistency.js";
import {
  CLIENT_RPC_CODES,
  RETRYABLE_RPC_CODES,
  rpcError,
  type JsonRpcError,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./jsonrpc.js";
import type { LatencyMetrics } from "./metrics.js";
import type { UpstreamPool } from "./pool.js";
import type { Rebroadcaster } from "./rebroadcast.js";
import { decodeWireTransaction, sendTransactionEncoding } from "./tx.js";
import type { CallOutcome, Upstream } from "./upstream.js";

export type UpstreamClass = "public" | "helius" | "sender" | "cache" | "none";

export interface Attempt {
  upstream: string;
  outcome: string;
  latencyMs: number;
}

export interface RouteContext {
  wallet: string;
  tier: Tier;
  requestId: string;
  /** Absolute epoch-ms deadline for this call. */
  deadline: number;
  sendVia?: "sender" | "rpc";
  rebroadcast?: boolean;
}

export interface RouteOutcome {
  response: JsonRpcResponse;
  billable: boolean;
  upstreamId?: string;
  upstreamClass: UpstreamClass;
  latencyMs: number;
  contextSlot?: number;
  escalated: boolean;
  sticky: boolean;
  attempts: Attempt[];
  /** Suggested HTTP status when this is the only call in the request. */
  httpStatusHint?: number;
  retryAfterMs?: number;
  injected?: { commitment?: Commitment; minContextSlot?: number };
}

export interface RouterOptions {
  defaultCommitment: Record<Tier, Commitment | undefined>;
  publicAttemptTimeoutMs: number;
  maxPublicAttempts: number;
  /** How long an economy call may wait for a free public rate-limit token. */
  economyQueueMs: number;
  /** How long a call may wait for a free Helius rate-limit token. */
  heliusQueueMs: number;
  cacheMaxEntryBytes: number;
}

export interface RouterDeps {
  pool: UpstreamPool;
  metrics: LatencyMetrics;
  hwm: SlotHighWaterMarks;
  txSessions: TxSessions;
  cache: LruCache<string, unknown>;
  rebroadcaster?: Rebroadcaster;
  logger: Logger;
  options: RouterOptions;
}

export const GATEWAY_ERRORS = {
  allFailed: { code: -32060, message: "No upstream could serve this request; it was not charged" },
  economyExhausted: {
    code: -32061,
    message: "The economy pool (free public RPC) could not serve this request; it was not charged. Retry, or use the standard or fast tier",
  },
  saturated: { code: -32062, message: "The gateway is at its upstream rate limit; retry shortly. Not charged" },
  sendUnknown: {
    code: -32063,
    message: "sendTransaction outcome unknown (upstream timed out); check getSignatureStatuses before re-sending. Not charged",
  },
  deadline: { code: -32064, message: "Request deadline exceeded before an upstream answered; not charged" },
} as const;

type Verdict = "success" | "client-error" | "retryable" | "unknown-error";

function verdictOf(out: CallOutcome): Verdict {
  if (out.kind !== "ok") return "retryable";
  const body = out.body;
  if ("result" in body && !("error" in body && body.error)) return "success";
  const code = (body as { error: JsonRpcError }).error.code;
  if (CLIENT_RPC_CODES.has(code)) return "client-error";
  if (RETRYABLE_RPC_CODES.has(code)) return "retryable";
  return "unknown-error";
}

interface Tried {
  final?: { out: Extract<CallOutcome, { kind: "ok" }>; upstream: Upstream; verdict: Verdict };
  /** Last JSON-RPC error seen, returned (unbilled) when nothing better exists. */
  lastRpcError?: JsonRpcError;
  saturated: boolean;
  retryAfterMs?: number;
  timedOut: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Methods that consume the Helius "heavy" rate-limit group (DAS, program scans). */
function heliusGroup(spec: MethodSpec): string | undefined {
  if (spec.name === "sendTransaction") return "send";
  if (spec.cls === "B" && spec.credits >= 10) return "heavy";
  return undefined;
}

export class Router {
  constructor(private readonly deps: RouterDeps) {}

  async execute(request: JsonRpcRequest, quote: QuoteItem, ctx: RouteContext): Promise<RouteOutcome> {
    const started = performance.now();
    const spec = quote.spec;
    const plan = quote.plan;
    if (!spec || !plan) throw new Error(`router received an unpriced item: ${request.method}`);
    const { pool, options, hwm, cache, txSessions } = this.deps;

    const multiUpstream = plan !== "helius";
    const prepared = prepareParams(spec, request.params, {
      commitment: options.defaultCommitment[ctx.tier],
      minContextSlot: multiUpstream ? (c) => hwm.floor(ctx.wallet, c) : undefined,
    });
    const injected =
      prepared.injectedCommitment || prepared.injectedMinContextSlot
        ? { commitment: prepared.injectedCommitment, minContextSlot: prepared.injectedMinContextSlot }
        : undefined;

    const cacheKey =
      spec.cacheableWhenFinalized && prepared.effectiveCommitment === "finalized"
        ? `${spec.name}:${canonicalJson(prepared.params ?? [])}`
        : undefined;
    if (cacheKey) {
      const hit = cache.get(cacheKey);
      if (hit !== undefined) {
        const latencyMs = performance.now() - started;
        this.deps.metrics.record(ctx.tier, spec.name, "cache", latencyMs, true);
        return {
          response: { jsonrpc: "2.0", id: request.id, result: hit },
          billable: true,
          upstreamClass: "cache",
          latencyMs,
          escalated: false,
          sticky: false,
          attempts: [],
          injected,
        };
      }
    }

    let effectivePlan = plan;
    let sticky = false;
    if (plan === "public-first" && pool.helius && TX_FOLLOWUP_METHODS.has(spec.name) && txSessions.active(ctx.wallet)) {
      effectivePlan = "helius";
      sticky = true;
    }

    const payload: Record<string, unknown> = { jsonrpc: "2.0", id: 1, method: spec.name };
    if (prepared.params !== undefined) payload.params = prepared.params;
    const attempts: Attempt[] = [];

    if (spec.name === "sendTransaction") {
      return this.sendTransaction(request, spec, payload, ctx, attempts, started);
    }

    let tried: Tried;
    let escalated = false;
    if (effectivePlan === "public-only") {
      tried = await this.tryPublics(spec, payload, ctx, attempts, "economy");
    } else if (effectivePlan === "public-first") {
      tried = await this.tryPublics(spec, payload, ctx, attempts, "standard");
      if (!tried.final || tried.final.verdict === "unknown-error") {
        escalated = true;
        const viaHelius = await this.tryHelius(spec, payload, ctx, attempts);
        if (viaHelius.final || !tried.final) tried = mergeTried(tried, viaHelius);
      }
    } else {
      tried = await this.tryHelius(spec, payload, ctx, attempts);
    }

    const latencyMs = performance.now() - started;
    if (tried.final) {
      const { out, upstream, verdict } = tried.final;
      const response = { ...out.body, id: request.id } as JsonRpcResponse;
      const result = "result" in out.body ? out.body.result : undefined;
      const slot = verdict === "success" ? responseSlot(spec, result) : undefined;
      if (slot !== undefined && prepared.effectiveCommitment) {
        hwm.observe(ctx.wallet, prepared.effectiveCommitment, slot);
        if (prepared.effectiveCommitment === "confirmed") upstream.observeSlot(slot);
      }
      if (cacheKey && verdict === "success" && result !== null && result !== undefined) {
        const size = JSON.stringify(result).length;
        if (size <= options.cacheMaxEntryBytes) cache.set(cacheKey, result, { size });
      }
      const billable = verdict === "success" || verdict === "client-error";
      this.deps.metrics.record(ctx.tier, spec.name, upstream.kind, latencyMs, billable);
      return {
        response,
        billable,
        upstreamId: upstream.id,
        upstreamClass: upstream.kind,
        latencyMs,
        contextSlot: slot,
        escalated,
        sticky,
        attempts,
        injected,
      };
    }

    this.deps.metrics.record(ctx.tier, spec.name, "none", latencyMs, false);
    let error: JsonRpcError;
    let httpStatusHint = 503;
    if (tried.saturated) {
      error = GATEWAY_ERRORS.saturated;
      httpStatusHint = 429;
    } else if (tried.timedOut && Date.now() >= ctx.deadline) {
      error = GATEWAY_ERRORS.deadline;
      httpStatusHint = 504;
    } else if (effectivePlan === "public-only") {
      error = GATEWAY_ERRORS.economyExhausted;
    } else {
      error = GATEWAY_ERRORS.allFailed;
    }
    const data: Record<string, unknown> = { attempts, requestId: ctx.requestId };
    if (tried.lastRpcError) data.lastUpstreamError = tried.lastRpcError;
    return {
      response: rpcError(request.id, { ...error, data }),
      billable: false,
      upstreamClass: "none",
      latencyMs,
      escalated,
      sticky,
      attempts,
      httpStatusHint,
      retryAfterMs: tried.retryAfterMs,
      injected,
    };
  }

  private remaining(ctx: RouteContext): number {
    return ctx.deadline - Date.now();
  }

  private async tryPublics(
    spec: MethodSpec,
    payload: Record<string, unknown>,
    ctx: RouteContext,
    attempts: Attempt[],
    mode: "economy" | "standard",
  ): Promise<Tried> {
    const { pool, options } = this.deps;
    const exclude = new Set<string>();
    const tried: Tried = { saturated: false, timedOut: false };
    const maxAttempts = Math.max(1, options.maxPublicAttempts);
    for (let i = 0; i < maxAttempts; i++) {
      let upstream = pool.pickPublic(spec.name, exclude);
      if (!upstream && mode === "economy") {
        // Economy may queue briefly for a free token instead of failing outright.
        const queueUntil = Date.now() + Math.min(options.economyQueueMs, Math.max(0, this.remaining(ctx) - 200));
        while (!upstream && Date.now() < queueUntil) {
          const wait = pool.publicWaitMs(spec.name, exclude);
          if (wait === undefined) break;
          await sleep(Math.max(10, Math.min(wait, queueUntil - Date.now())));
          upstream = pool.pickPublic(spec.name, exclude);
        }
      }
      if (!upstream) {
        if (pool.eligiblePublics(spec.name, exclude).length > 0) {
          tried.saturated = true;
          tried.retryAfterMs = pool.publicWaitMs(spec.name, exclude);
        }
        break;
      }
      exclude.add(upstream.id);
      const remaining = this.remaining(ctx);
      if (remaining <= 50) {
        tried.timedOut = true;
        break;
      }
      const attemptsLeft = maxAttempts - i;
      const timeout =
        mode === "standard"
          ? Math.min(options.publicAttemptTimeoutMs, remaining)
          : Math.max(250, Math.floor(remaining / attemptsLeft));
      const out = await upstream.call(payload, timeout);
      const verdict = this.recordAttempt(upstream, spec, out, attempts);
      tried.saturated = false;
      if (out.kind === "timeout") tried.timedOut = true;
      if (verdict === "success" || verdict === "client-error") {
        tried.final = { out: out as Extract<CallOutcome, { kind: "ok" }>, upstream, verdict };
        return tried;
      }
      if (out.kind === "ok" && "error" in out.body) tried.lastRpcError = out.body.error;
      if (verdict === "unknown-error" && mode === "economy" && i === maxAttempts - 1) {
        tried.final = { out: out as Extract<CallOutcome, { kind: "ok" }>, upstream, verdict };
        return tried;
      }
    }
    return tried;
  }

  private async tryHelius(
    spec: MethodSpec,
    payload: Record<string, unknown>,
    ctx: RouteContext,
    attempts: Attempt[],
  ): Promise<Tried> {
    const { pool, options } = this.deps;
    const tried: Tried = { saturated: false, timedOut: false };
    const helius = pool.helius;
    if (!helius) return tried;
    const group = heliusGroup(spec);
    const maxAttempts = 2;
    for (let i = 0; i < maxAttempts; i++) {
      if (!helius.isAvailable() && i > 0) break;
      if (!(await this.takeHeliusToken(helius, group, ctx))) {
        tried.saturated = true;
        tried.retryAfterMs = helius.waitMs(group);
        break;
      }
      const remaining = this.remaining(ctx);
      if (remaining <= 50) {
        tried.timedOut = true;
        break;
      }
      const out = await helius.call(payload, remaining);
      const verdict = this.recordAttempt(helius, spec, out, attempts);
      tried.saturated = false;
      if (out.kind === "timeout") tried.timedOut = true;
      if (verdict === "success" || verdict === "client-error" || verdict === "unknown-error") {
        tried.final = { out: out as Extract<CallOutcome, { kind: "ok" }>, upstream: helius, verdict };
        return tried;
      }
      if (out.kind === "ok" && "error" in out.body) {
        tried.lastRpcError = out.body.error;
        if (out.body.error.code === -32601) break; // Helius does not serve it; retrying won't help.
      }
      if (out.kind === "rate-limited") {
        tried.saturated = true;
        tried.retryAfterMs = out.retryAfterMs;
        break;
      }
    }
    return tried;
  }

  private async takeHeliusToken(helius: Upstream, group: string | undefined, ctx: RouteContext): Promise<boolean> {
    if (helius.tryTake(group)) return true;
    const until = Date.now() + Math.min(this.deps.options.heliusQueueMs, Math.max(0, this.remaining(ctx) - 200));
    while (Date.now() < until) {
      await sleep(Math.max(5, Math.min(helius.waitMs(group), until - Date.now())));
      if (helius.tryTake(group)) return true;
    }
    return false;
  }

  /** Updates upstream health from one outcome and logs the attempt. */
  private recordAttempt(upstream: Upstream, spec: MethodSpec, out: CallOutcome, attempts: Attempt[]): Verdict {
    const verdict = verdictOf(out);
    const now = Date.now();
    let label: string = out.kind;
    if (out.kind === "ok") {
      if (verdict === "success" || verdict === "client-error") upstream.noteSuccess(out.latencyMs, now);
      if ("error" in out.body && out.body.error) {
        const code = out.body.error.code;
        label = `rpc-error ${code}`;
        if (code === -32005) upstream.noteFailure(now);
        if (code === -32601 && upstream.kind === "public") {
          upstream.denyMethods.add(spec.name);
          this.deps.logger.info("learned unsupported method", { upstream: upstream.id, method: spec.name });
        }
      }
    } else if (out.kind === "rate-limited") {
      upstream.noteRateLimited(out.retryAfterMs, now);
    } else {
      upstream.noteFailure(now);
    }
    attempts.push({ upstream: upstream.id, outcome: label, latencyMs: Math.round(out.latencyMs) });
    return verdict;
  }

  private async sendTransaction(
    request: JsonRpcRequest,
    spec: MethodSpec,
    payload: Record<string, unknown>,
    ctx: RouteContext,
    attempts: Attempt[],
    started: number,
  ): Promise<RouteOutcome> {
    const { pool, txSessions, rebroadcaster } = this.deps;
    const target = ctx.sendVia === "sender" && pool.sender ? pool.sender : pool.helius;
    const fail = (error: JsonRpcError, httpStatusHint: number, retryAfterMs?: number): RouteOutcome => {
      const latencyMs = performance.now() - started;
      this.deps.metrics.record(ctx.tier, spec.name, "none", latencyMs, false);
      return {
        response: rpcError(request.id, { ...error, data: { attempts, requestId: ctx.requestId } }),
        billable: false,
        upstreamClass: "none",
        latencyMs,
        escalated: false,
        sticky: false,
        attempts,
        httpStatusHint,
        retryAfterMs,
      };
    };
    if (!target) return fail(GATEWAY_ERRORS.allFailed, 503);
    if (!(await this.takeHeliusToken(target, "send", ctx))) {
      return fail(GATEWAY_ERRORS.saturated, 429, target.waitMs("send"));
    }
    const out = await target.call(payload, Math.max(1000, this.remaining(ctx)));
    const verdict = this.recordAttempt(target, spec, out, attempts);
    if (out.kind === "timeout") return fail(GATEWAY_ERRORS.sendUnknown, 504);
    if (out.kind === "rate-limited") return fail(GATEWAY_ERRORS.saturated, 429, out.retryAfterMs);
    if (out.kind !== "ok") return fail(GATEWAY_ERRORS.allFailed, 502);

    const latencyMs = performance.now() - started;
    const billable = verdict === "success" || verdict === "client-error";
    this.deps.metrics.record(ctx.tier, spec.name, target.kind, latencyMs, billable);
    if (verdict === "success") {
      txSessions.touch(ctx.wallet);
      const params = Array.isArray(request.params) ? request.params : [];
      if (ctx.rebroadcast && rebroadcaster && pool.helius && typeof params[0] === "string") {
        try {
          const encoding = sendTransactionEncoding(params);
          const decoded = decodeWireTransaction(params[0], encoding);
          rebroadcaster.start({
            signature: decoded.signature,
            rawTx: params[0],
            encoding,
            blockhash: decoded.recentBlockhash,
            upstream: pool.helius,
          });
        } catch (err) {
          this.deps.logger.debug("rebroadcast skipped", { error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
    return {
      response: { ...out.body, id: request.id } as JsonRpcResponse,
      billable,
      upstreamId: target.id,
      upstreamClass: target.kind,
      latencyMs,
      escalated: false,
      sticky: false,
      attempts,
    };
  }
}

function mergeTried(a: Tried, b: Tried): Tried {
  return {
    final: b.final ?? a.final,
    lastRpcError: b.lastRpcError ?? a.lastRpcError,
    saturated: b.final ? false : b.saturated,
    retryAfterMs: b.retryAfterMs ?? a.retryAfterMs,
    timedOut: a.timedOut || b.timedOut,
  };
}
