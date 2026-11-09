import type { Context } from "hono";

export const ODOMETER_HEADERS = [
  "x-odometer-request-id",
  "x-odometer-tier",
  "x-odometer-wallet",
  "x-odometer-charged",
  "x-odometer-charged-usd",
  "x-odometer-balance",
  "x-odometer-balance-usd",
  "x-odometer-upstream",
  "x-odometer-upstream-class",
  "x-odometer-escalated",
  "x-odometer-sticky",
  "x-odometer-context-slot",
  "x-odometer-best-slot",
  "x-odometer-latency-ms",
  "x-odometer-session",
  "x-odometer-session-expires",
  "x-odometer-idempotent-replay",
  "x-odometer-commitment-injected",
  "x-odometer-min-context-slot",
];

/** Builds a JSON response with extra headers. */
export function jsonResponse(c: Context, status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const res = c.json(body as object, status as 200);
  for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
  return res;
}

export function rawJsonResponse(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
}

/** Runs `fn` over `items` with at most `limit` in flight, preserving order. */
export async function mapConcurrent<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export function retryAfterUntilUtcMidnight(now = Date.now()): string {
  const d = new Date(now);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return String(Math.max(1, Math.ceil((midnight - now) / 1000)));
}
