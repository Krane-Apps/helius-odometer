import type { Context, Hono } from "hono";
import type { AppDeps } from "../server/deps.js";
import { jsonResponse } from "../server/http.js";
import { newId } from "../util/ids.js";
import { safeJsonParse } from "../util/json.js";
import { metered, type RunResult } from "./metered.js";

/** Helius REST endpoints exposed behind the same prepaid balance. */
export const REST_ROUTES = [
  {
    id: "enhanced-transactions",
    pattern: "POST /v1/helius/v0/transactions",
    description: "Helius Enhanced Transactions API: parse up to 100 transaction signatures into human-readable events.",
  },
  {
    id: "enhanced-address-history",
    pattern: "GET /v1/helius/v0/addresses/*",
    description: "Helius Enhanced Transactions API: parsed transaction history for an address.",
  },
] as const;

const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const HISTORY_QUERY = new Set(["before", "until", "limit", "type", "source", "commitment", "sort-order", "gt-slot", "lt-slot", "gt-time", "lt-time"]);

export function restEnabled(deps: Pick<AppDeps, "config">): boolean {
  return !!(deps.config.heliusApiBase && deps.config.heliusApiKey && deps.config.helius);
}

export function registerHeliusRestRoutes(app: Hono, deps: AppDeps): void {
  if (!restEnabled(deps)) return;
  app.post("/v1/helius/v0/transactions", async (c) => {
    const text = await c.req.text();
    const body = safeJsonParse(text);
    if (!body.ok || !body.value || typeof body.value !== "object" || !Array.isArray((body.value as { transactions?: unknown }).transactions)) {
      return jsonResponse(c, 400, { error: "invalid_body", message: 'Expected {"transactions": ["<signature>", ...]}' });
    }
    const sigs = (body.value as { transactions: unknown[] }).transactions;
    if (sigs.length === 0 || sigs.length > 100 || !sigs.every((s) => typeof s === "string" && s.length <= 100)) {
      return jsonResponse(c, 400, { error: "invalid_body", message: "transactions must be 1-100 signatures" });
    }
    return proxy(c, deps, "enhanced-transactions", "POST", "/v0/transactions", "", text, body.value);
  });
  app.get("/v1/helius/v0/addresses/:address/transactions", async (c) => {
    const address = c.req.param("address");
    if (!ADDRESS_RE.test(address)) return jsonResponse(c, 400, { error: "invalid_address" });
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(c.req.queries())) {
      if (HISTORY_QUERY.has(k) && v[0] !== undefined) query.set(k, v[0]);
    }
    return proxy(c, deps, "enhanced-address-history", "GET", `/v0/addresses/${address}/transactions`, query.toString(), undefined, {});
  });
}

async function proxy(
  c: Context,
  deps: AppDeps,
  routeId: string,
  method: "GET" | "POST",
  path: string,
  query: string,
  rawBody: string | undefined,
  parsedBody: unknown,
): Promise<Response> {
  const price = deps.pricing.restPrice(routeId);
  if (price === undefined) return jsonResponse(c, 404, { error: "route_not_priced" });
  const requestId = newId("req");
  return metered(c, deps, {
    requestId,
    tier: "helius-rest",
    price,
    methods: [routeId],
    body: parsedBody,
    fingerprint: `${method} ${path}?${query}\n${rawBody ?? ""}`,
    run: async (): Promise<RunResult> => {
      const helius = deps.pool.helius!;
      const url = new URL(`${deps.config.heliusApiBase!.replace(/\/+$/, "")}${path}`);
      if (query) url.search = query;
      url.searchParams.set("api-key", deps.config.heliusApiKey!);
      if (!helius.tryTake("heavy")) {
        return { status: 429, body: JSON.stringify({ error: "rate_limited", message: "Helius REST rate limit; not charged" }), headers: { "retry-after": "1" }, charged: 0, calls: 0 };
      }
      const started = performance.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), deps.config.timeouts.fast);
      try {
        const res = await fetch(url, {
          method,
          headers: { "content-type": "application/json", accept: "application/json" },
          body: rawBody,
          signal: controller.signal,
        });
        const text = await res.text();
        const latency = performance.now() - started;
        const billable = (res.status >= 200 && res.status < 300) || (res.status >= 400 && res.status < 500 && res.status !== 429);
        deps.counters.heliusCalls += 1;
        deps.counters.heliusCreditsEstimate += 100;
        deps.metrics.record("helius-rest", routeId, "helius", latency, billable);
        return {
          status: res.status,
          body: text,
          headers: {
            "x-odometer-upstream": "helius",
            "x-odometer-upstream-class": "helius",
            "x-odometer-latency-ms": String(Math.round(latency)),
          },
          charged: billable ? price : 0,
          calls: billable ? 1 : 0,
        };
      } catch (err) {
        const timedOut = controller.signal.aborted;
        return {
          status: timedOut ? 504 : 502,
          body: JSON.stringify({ error: timedOut ? "upstream_timeout" : "upstream_error", message: "Not charged" }),
          headers: {},
          charged: 0,
          calls: 0,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
