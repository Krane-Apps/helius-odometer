import type { Context, Hono } from "hono";
import { parseJsonRpcBody, PARSE_ERROR, rpcError } from "../routing/jsonrpc.js";
import type { Upstream } from "../routing/upstream.js";
import type { AppDeps } from "../server/deps.js";
import { jsonResponse } from "../server/http.js";
import { canonicalJson, safeJsonParse } from "../util/json.js";

/**
 * Free, tightly limited RPC for building the x402 payment itself, so an agent
 * with nothing but a wallet can pay: it needs a recent blockhash and the
 * payment mint's account. Nothing else is served here.
 */
const TTL_MS: Record<string, number> = {
  getLatestBlockhash: 2_000,
  getAccountInfo: 10 * 60_000,
  getGenesisHash: 60 * 60_000,
  getVersion: 10 * 60_000,
  getHealth: 2_000,
  getMinimumBalanceForRentExemption: 10 * 60_000,
};

export function registerBootstrapRoutes(app: Hono, deps: AppDeps): void {
  if (!deps.config.bootstrapEnabled) return;
  app.post("/v1/bootstrap", (c) => handleBootstrap(c, deps));
}

async function handleBootstrap(c: Context, deps: AppDeps): Promise<Response> {
  const limited = deps.bootstrapLimiter.tryTake(deps.clientIp(c));
  if (!limited.ok) {
    return jsonResponse(c, 429, rpcError(null, { code: -32062, message: "bootstrap rate limit" }), {
      "retry-after": String(Math.max(1, Math.ceil(limited.retryAfterMs / 1000))),
    });
  }
  const parsedJson = safeJsonParse(await c.req.text());
  if (!parsedJson.ok) return jsonResponse(c, 400, rpcError(null, PARSE_ERROR));
  const parsed = parseJsonRpcBody(parsedJson.value, 1);
  if (!parsed.ok) return jsonResponse(c, parsed.httpStatus, parsed.error);
  const req = parsed.requests[0]!;
  if ("invalid" in req) return jsonResponse(c, 400, req.invalid);
  const ttl = TTL_MS[req.method];
  const params = Array.isArray(req.params) ? req.params : [];
  const allowed =
    ttl !== undefined && (req.method !== "getAccountInfo" || params[0] === deps.config.paymentAsset);
  if (!allowed) {
    return jsonResponse(
      c,
      403,
      rpcError(req.id, {
        code: -32050,
        message: "The bootstrap endpoint only serves what is needed to build a payment. Use /v1/rpc/<tier> for everything else.",
      }),
    );
  }
  const key = `${req.method}:${canonicalJson(params)}`;
  const cached = deps.bootstrapCache.get(key);
  if (cached !== undefined) return jsonResponse(c, 200, { jsonrpc: "2.0", id: req.id, result: cached });

  const exclude = new Set<string>();
  const candidates: Array<Upstream | undefined> = [deps.pool.pickPublic(req.method, exclude)];
  if (deps.pool.helius?.tryTake()) candidates.push(deps.pool.helius);
  for (const upstream of candidates) {
    if (!upstream) continue;
    const out = await upstream.call({ jsonrpc: "2.0", id: 1, method: req.method, params }, 5000);
    if (out.kind === "ok" && "result" in out.body) {
      deps.bootstrapCache.set(key, out.body.result, { ttlMs: ttl });
      return jsonResponse(c, 200, { jsonrpc: "2.0", id: req.id, result: out.body.result });
    }
  }
  return jsonResponse(c, 503, rpcError(req.id, { code: -32060, message: "No upstream available for bootstrap" }));
}
