import type { Context, Hono } from "hono";
import { isTier, RPC_ERRORS, type QuoteItem, type Tier } from "../pricing/pricing.js";
import { parseJsonRpcBody, PARSE_ERROR, rpcError, type JsonRpcFailure, type JsonRpcRequest, type JsonRpcResponse } from "../routing/jsonrpc.js";
import type { RouteOutcome } from "../routing/router.js";
import type { AppDeps } from "../server/deps.js";
import { jsonResponse, mapConcurrent } from "../server/http.js";
import { newId } from "../util/ids.js";
import { safeJsonParse } from "../util/json.js";
import { metered } from "./metered.js";

type Item =
  | { kind: "invalid"; response: JsonRpcFailure }
  | { kind: "rejected"; request: JsonRpcRequest; response: JsonRpcFailure; httpStatus: number }
  | { kind: "payable"; request: JsonRpcRequest; quote: QuoteItem };

const BATCH_CONCURRENCY = 8;

export function registerRpcRoutes(app: Hono, deps: AppDeps): void {
  app.post("/v1/rpc/:tier", (c) => handleRpc(c, deps));
}

async function handleRpc(c: Context, deps: AppDeps): Promise<Response> {
  const requestId = newId("req");
  const base = { "x-odometer-request-id": requestId };
  const tierParam = c.req.param("tier") ?? "";
  if (!isTier(tierParam) || !deps.enabledTiers.has(tierParam)) {
    return jsonResponse(
      c,
      404,
      rpcError(null, { ...RPC_ERRORS.tierUnavailable, data: { enabledTiers: [...deps.enabledTiers] } }),
      base,
    );
  }
  const tier: Tier = tierParam;
  const text = await c.req.text();
  const parsedJson = safeJsonParse(text);
  if (!parsedJson.ok) return jsonResponse(c, 400, rpcError(null, PARSE_ERROR), base);
  const parsed = parseJsonRpcBody(parsedJson.value, deps.config.maxBatch);
  if (!parsed.ok) return jsonResponse(c, parsed.httpStatus, parsed.error, base);

  const valid = parsed.requests.filter((r): r is JsonRpcRequest => !("invalid" in r));
  const quote = deps.pricing.quote(
    tier,
    valid.map((r) => r.method),
    deps.pricingOptions,
  );
  let q = 0;
  const items: Item[] = parsed.requests.map((r) => {
    if ("invalid" in r) return { kind: "invalid", response: r.invalid };
    const qi = quote.items[q++]!;
    if (qi.reject) {
      return {
        kind: "rejected",
        request: r,
        response: rpcError(r.id, { code: qi.reject.code, message: qi.reject.message }),
        httpStatus: qi.reject.httpStatus,
      };
    }
    return { kind: "payable", request: r, quote: qi };
  });
  const payable = items.filter((i): i is Extract<Item, { kind: "payable" }> => i.kind === "payable");

  if (payable.length === 0) {
    const responses = items.map((i) => (i.kind === "payable" ? rpcError(i.request.id, { code: -32603, message: "unreachable" }) : i.response));
    if (!parsed.batch) {
      const only = items[0]!;
      return jsonResponse(c, only.kind === "rejected" ? only.httpStatus : 400, responses[0], base);
    }
    return jsonResponse(c, 200, responses, base);
  }

  return metered(c, deps, {
    requestId,
    tier,
    price: quote.total,
    methods: payable.map((p) => p.request.method),
    body: parsedJson.value,
    fingerprint: text,
    run: async (wallet) => {
      const sendVia = c.req.header("x-odometer-send-via");
      const deadline = Date.now() + deps.config.timeouts[tier];
      const outcomes = await mapConcurrent(payable, BATCH_CONCURRENCY, (p) =>
        deps.router.execute(p.request, p.quote, {
          wallet,
          tier,
          requestId,
          deadline,
          sendVia: sendVia === "sender" ? "sender" : sendVia === "rpc" ? "rpc" : undefined,
          rebroadcast: /^(1|true|yes)$/i.test(c.req.header("x-odometer-rebroadcast") ?? ""),
        }),
      );
      const byRequest = new Map<JsonRpcRequest, RouteOutcome>();
      payable.forEach((p, i) => byRequest.set(p.request, outcomes[i]!));

      let charged = 0;
      let calls = 0;
      payable.forEach((p, i) => {
        const o = outcomes[i]!;
        countOutcome(deps, p.quote, o);
        if (o.billable) {
          charged += p.quote.price;
          calls += 1;
        }
      });

      const responses: JsonRpcResponse[] = items.map((i) =>
        i.kind === "payable" ? byRequest.get(i.request)!.response : i.response,
      );
      const headers = diagnosticHeaders(deps, outcomes);
      let status = 200;
      if (!parsed.batch) {
        const o = outcomes[0]!;
        if (!o.billable) {
          status = o.httpStatusHint ?? 502;
          if (o.retryAfterMs) headers["retry-after"] = String(Math.max(1, Math.ceil(o.retryAfterMs / 1000)));
        }
      }
      return {
        status,
        body: JSON.stringify(parsed.batch ? responses : responses[0]),
        headers,
        charged,
        calls,
      };
    },
  });
}

function countOutcome(deps: AppDeps, quote: QuoteItem, o: RouteOutcome): void {
  const c = deps.counters;
  c.calls += 1;
  if (o.billable) c.billableCalls += 1;
  if (o.escalated) c.escalations += 1;
  if (o.upstreamClass === "cache") c.cacheHits += 1;
  if (o.upstreamClass === "public") c.publicCalls += 1;
  // Helius bills every request that reaches it, served or not.
  const heliusAttempts = o.attempts.filter((a) => a.upstream === "helius").length;
  if (heliusAttempts > 0) {
    c.heliusCalls += heliusAttempts;
    c.heliusCreditsEstimate += heliusAttempts * (quote.spec?.credits ?? 1);
  }
}

function diagnosticHeaders(deps: AppDeps, outcomes: RouteOutcome[]): Record<string, string> {
  const h: Record<string, string> = {
    "x-odometer-upstream": outcomes.map((o) => o.upstreamId ?? "none").join(","),
    "x-odometer-upstream-class": outcomes.map((o) => o.upstreamClass).join(","),
    "x-odometer-escalated": outcomes.map((o) => String(o.escalated)).join(","),
    "x-odometer-latency-ms": String(Math.round(Math.max(...outcomes.map((o) => o.latencyMs)))),
  };
  const best = deps.pool.bestSlot();
  if (best !== undefined) h["x-odometer-best-slot"] = String(best);
  if (outcomes.some((o) => o.sticky)) h["x-odometer-sticky"] = outcomes.map((o) => String(o.sticky)).join(",");
  if (outcomes.length === 1) {
    const o = outcomes[0]!;
    if (o.contextSlot !== undefined) h["x-odometer-context-slot"] = String(o.contextSlot);
    if (o.injected?.commitment) h["x-odometer-commitment-injected"] = o.injected.commitment;
    if (o.injected?.minContextSlot !== undefined) h["x-odometer-min-context-slot"] = String(o.injected.minContextSlot);
  }
  return h;
}
