import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { PaymentRequirements, Price, SettleResponse } from "@x402/core/types";
import { extractPaymentFromMeta, MCP_PAYMENT_RESPONSE_META_KEY } from "@x402/mcp";
import { z } from "zod";
import { TIER_DESCRIPTIONS } from "../payments/x402.js";
import type { Tier } from "../pricing/pricing.js";
import type { AppDeps } from "../server/deps.js";
import { newId } from "../util/ids.js";
import { microsToUsd } from "../util/money.js";

interface McpSession {
  transport?: WebStandardStreamableHTTPServerTransport;
  server?: McpServer;
  /** The wallet that paid a top-up in this MCP session; later calls spend its balance. */
  wallet?: string;
  lastSeen: number;
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
};

const text = (value: unknown, isError = false): ToolResult => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  isError,
});

/**
 * Remote MCP over streamable HTTP at /mcp, paid with the x402 MCP transport.
 *
 * Paying per tool call on-chain would cost far more than an RPC call, so the
 * 402 for a tool asks for a prepaid top-up instead. Once a top-up settles,
 * the paying wallet is bound to this MCP session and later calls in the
 * session are debited from its balance with no new payment. A new session
 * pays again (credited to the same wallet balance, which stays refundable).
 */
export function registerRemoteMcp(app: Hono, deps: AppDeps, opts: { idleMs?: number } = {}): () => Promise<void> {
  const sessions = new Map<string, McpSession>();
  const idleMs = opts.idleMs ?? 30 * 60_000;
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) {
      if (now - s.lastSeen > idleMs) {
        sessions.delete(id);
        void s.transport?.close().catch(() => {});
      }
    }
  }, 60_000);
  sweeper.unref();

  app.all("/mcp", async (c) => {
    const sid = c.req.header("mcp-session-id");
    let session = sid ? sessions.get(sid) : undefined;
    if (sid && !session) {
      return c.json({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found; initialize a new session" }, id: null }, 404);
    }
    if (!session) {
      const state: McpSession = { lastSeen: Date.now() };
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, state);
        },
        onsessionclosed: (id) => {
          sessions.delete(id);
        },
      });
      const server = buildServer(deps, state);
      await server.connect(transport);
      state.transport = transport;
      state.server = server;
      session = state;
    }
    session.lastSeen = Date.now();
    return session.transport!.handleRequest(c.req.raw);
  });

  return async () => {
    clearInterval(sweeper);
    await Promise.all([...sessions.values()].map((s) => s.transport?.close().catch(() => {})));
    sessions.clear();
  };
}

function buildServer(deps: AppDeps, state: McpSession): McpServer {
  const server = new McpServer(
    { name: "helius-odometer", version: "0.1.0" },
    {
      instructions:
        "Helius Odometer: pay-per-call Solana RPC. Before your first call, ask your user how important speed is " +
        "(economy: free public RPC only; standard: public with automatic Helius fallback; fast: always Helius). " +
        "The first paid call asks for a prepaid USDC top-up over x402; later calls in this session spend that balance.",
    },
  );
  const paramsSchema = z
    .union([z.array(z.unknown()), z.record(z.string(), z.unknown())])
    .optional()
    .describe("Positional params array, or a named params object for DAS methods");

  for (const tier of deps.enabledTiers) {
    server.registerTool(
      `solana_rpc_${tier}`,
      {
        title: `Solana RPC (${tier} tier)`,
        description: `${TIER_DESCRIPTIONS[tier]} Ask your user how important speed is before choosing a tier. Paid from a prepaid balance topped up over x402.`,
        inputSchema: { method: z.string().min(1), params: paramsSchema },
        annotations: { openWorldHint: true },
      },
      async ({ method, params }, extra) => paidCall(deps, state, tier, method, params, extra._meta as Record<string, unknown> | undefined),
    );
  }

  server.registerTool(
    "odometer_balance",
    { title: "Prepaid balance", description: "Balance of the wallet bound to this MCP session.", inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => {
      if (!state.wallet) return text({ message: "No wallet is bound to this session yet; the first paid call binds the paying wallet." });
      const a = deps.ledger.getAccount(state.wallet);
      return text({ wallet: state.wallet, availableUsd: microsToUsd(a?.available ?? 0) });
    },
  );

  server.registerTool(
    "odometer_pricing",
    {
      title: "Pricing",
      description: "Price per call by tier for one method.",
      inputSchema: { method: z.string().min(1) },
      annotations: { readOnlyHint: true },
    },
    async ({ method }) => {
      const prices: Record<string, string | null> = {};
      for (const tier of deps.enabledTiers) {
        const q = deps.pricing.priceMethod(tier, method, deps.pricingOptions);
        prices[tier] = q.reject ? null : microsToUsd(q.price);
      }
      return text({ method, priceUsd: prices, topupOptionsUsd: deps.config.topupOptionsUsd });
    },
  );
  return server;
}

async function topupRequirements(deps: AppDeps): Promise<PaymentRequirements[]> {
  const built = await Promise.all(
    deps.payments.topupOptions().map((o) =>
      deps.payments.resourceServer.buildPaymentRequirements({
        scheme: o.scheme,
        network: o.network,
        payTo: o.payTo as string,
        price: o.price as Price,
        maxTimeoutSeconds: o.maxTimeoutSeconds,
        extra: o.extra,
      }),
    ),
  );
  return built.flat();
}

async function paymentRequired(deps: AppDeps, toolName: string, accepts: PaymentRequirements[], error: string): Promise<ToolResult> {
  const pr = await deps.payments.resourceServer.createPaymentRequiredResponse(
    accepts,
    {
      url: `mcp://tool/${toolName}`,
      description: "Prepaid USDC top-up for Helius Odometer; later calls in this MCP session spend the balance.",
      mimeType: "application/json",
    },
    error,
  );
  return { structuredContent: pr as unknown as Record<string, unknown>, content: [{ type: "text", text: JSON.stringify(pr) }], isError: true };
}

async function paidCall(
  deps: AppDeps,
  state: McpSession,
  tier: Tier,
  method: string,
  params: unknown,
  meta: Record<string, unknown> | undefined,
): Promise<ToolResult> {
  const toolName = `solana_rpc_${tier}`;
  const quote = deps.pricing.quote(tier, [method], deps.pricingOptions).items[0]!;
  if (quote.reject) return text({ error: { code: quote.reject.code, message: quote.reject.message } }, true);

  let settlement: SettleResponse | undefined;
  if (!state.wallet || deps.ledger.available(state.wallet) < quote.price) {
    if (!deps.payments.initialized) {
      try {
        await deps.payments.initialize();
      } catch {
        return text({ error: "payments_unavailable", message: "The payment facilitator is unreachable; retry shortly." }, true);
      }
    }
    const accepts = await topupRequirements(deps);
    const payload = extractPaymentFromMeta({ name: toolName, arguments: { method, params }, _meta: meta });
    if (!payload) {
      return paymentRequired(deps, toolName, accepts, state.wallet ? "Prepaid balance too low; pay a top-up" : "Payment required: pay a prepaid top-up");
    }
    const match = deps.payments.resourceServer.findMatchingRequirements(accepts, payload);
    if (!match) return paymentRequired(deps, toolName, accepts, "No matching payment requirements");
    const result = await deps.payments.resourceServer.settlePayment(payload, match, {}, { toolName }, undefined, "before-handler");
    if (!result.success || !result.payer) {
      return paymentRequired(deps, toolName, accepts, result.errorReason ?? result.errorMessage ?? "Settlement failed");
    }
    state.wallet = result.payer;
    settlement = result;
    deps.counters.topups += 1;
  }
  const wallet = state.wallet;
  const limited = deps.walletLimiter.tryTake(wallet);
  if (!limited.ok) return text({ error: "rate_limited", message: "Per-wallet request rate exceeded; not charged" }, true);

  const requestId = newId("req");
  const reservation = deps.ledger.reserve({ wallet, amount: quote.price, tier, methods: [method], requestId });
  if (!reservation.ok) {
    if (reservation.reason === "daily_cap_exceeded") {
      return text({ error: "daily_cap_exceeded", message: "This wallet reached its daily spend cap; not charged" }, true);
    }
    return paymentRequired(deps, toolName, await topupRequirements(deps), "Prepaid balance too low; pay a top-up");
  }
  let outcome;
  try {
    outcome = await deps.router.execute(
      { jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params: params as unknown[] }) },
      quote,
      { wallet, tier, requestId, deadline: Date.now() + deps.config.timeouts[tier] },
    );
  } catch (err) {
    deps.ledger.release(reservation.reservationId);
    deps.logger.error("mcp call failed", { requestId, error: err });
    return text({ error: "internal_error", requestId }, true);
  }
  const fin = deps.ledger.finalize(reservation.reservationId, outcome.billable ? quote.price : 0, outcome.billable ? 1 : 0);
  deps.counters.calls += 1;
  deps.counters.revenueMicros += fin.charged;
  if (outcome.billable) deps.counters.billableCalls += 1;
  const response = outcome.response as { result?: unknown; error?: unknown };
  const result: ToolResult = text(
    {
      result: response.result,
      error: response.error,
      cost: { chargedUsd: microsToUsd(fin.charged), balanceUsd: microsToUsd(fin.available) },
      routing: { tier, upstreamClass: outcome.upstreamClass, escalated: outcome.escalated, latencyMs: Math.round(outcome.latencyMs) },
    },
    response.error !== undefined,
  );
  if (settlement) result._meta = { [MCP_PAYMENT_RESPONSE_META_KEY]: settlement };
  return result;
}
