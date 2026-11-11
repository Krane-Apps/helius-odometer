import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { PaymentRequirements, SettleResponse } from "@x402/core/types";
import { extractPaymentFromMeta, MCP_PAYMENT_RESPONSE_META_KEY } from "@x402/mcp";
import { z } from "zod";
import { bearerToken } from "../payments/session.js";
import { TIER_DESCRIPTIONS } from "../payments/x402.js";
import type { Tier } from "../pricing/pricing.js";
import type { AppDeps } from "../server/deps.js";
import { newId } from "../util/ids.js";
import { canonicalJson, sha256Hex } from "../util/json.js";
import { atomicToMicros, microsToUsd, usdToMicros } from "../util/money.js";
import { KeyedRateLimiter } from "../util/token-bucket.js";

/**
 * What a bare MCP session id may spend. It is created by a top-up paid inside
 * this session and is limited to that amount: the session id is never
 * authority over the wallet's whole balance. Every use re-checks the wallet's
 * revocation epoch, an absolute expiry and (optionally) the client IP.
 */
interface Binding {
  wallet: string;
  epoch: number;
  boundAt: number;
  expiresAt: number;
  voucherMicros: number;
  ip: string;
}

interface McpSession {
  id?: string;
  transport?: WebStandardStreamableHTTPServerTransport;
  server?: McpServer;
  createdAt: number;
  lastSeen: number;
  binding?: Binding;
}

interface CallAuth {
  /** Session token from the HTTP Authorization header, if any. */
  token: string;
  ip: string;
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
};

export interface RemoteMcp {
  close(): Promise<void>;
  /** Terminates every MCP session bound to the wallet. Returns how many were closed. */
  revokeWallet(wallet: string): Promise<number>;
  sessionCount(): number;
}

const text = (value: unknown, isError = false): ToolResult => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  isError,
});

/**
 * Remote MCP over streamable HTTP at /mcp, paid with the x402 MCP transport.
 *
 * Paying per tool call on-chain would cost more than the call, so a tool's 402
 * asks for a prepaid top-up. Two ways to spend afterwards:
 *  - `Authorization: Bearer <session token>` on the MCP HTTP requests spends the
 *    wallet's balance, revocable like every session token;
 *  - otherwise the session may spend only what was paid within it (see Binding).
 */
export function registerRemoteMcp(app: Hono, deps: AppDeps, opts: { idleMs?: number; maxAgeMs?: number } = {}): RemoteMcp {
  const { config } = deps;
  const sessions = new Map<string, McpSession>();
  const byWallet = new Map<string, Set<string>>();
  const idleMs = opts.idleMs ?? 30 * 60_000;
  const maxAgeMs = opts.maxAgeMs ?? 24 * 3_600_000;
  const creationLimiter = new KeyedRateLimiter(config.remoteMcpSessionsPerMinute / 60, Math.max(1, config.remoteMcpSessionsPerMinute));

  const index = {
    bind(state: McpSession, binding: Binding) {
      index.unbind(state);
      state.binding = binding;
      if (!state.id) return;
      let set = byWallet.get(binding.wallet);
      if (!set) byWallet.set(binding.wallet, (set = new Set()));
      set.add(state.id);
    },
    unbind(state: McpSession) {
      if (state.id && state.binding) {
        const set = byWallet.get(state.binding.wallet);
        set?.delete(state.id);
        if (set && set.size === 0) byWallet.delete(state.binding.wallet);
      }
      state.binding = undefined;
    },
  };

  const closeSession = async (id: string): Promise<void> => {
    const state = sessions.get(id);
    if (!state) return;
    sessions.delete(id);
    index.unbind(state);
    await state.transport?.close().catch(() => {});
  };

  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) {
      if (now - s.lastSeen > idleMs || now - s.createdAt > maxAgeMs) void closeSession(id);
    }
  }, 60_000);
  sweeper.unref();

  app.all("/mcp", async (c) => {
    const ip = deps.clientIp(c);
    const sid = c.req.header("mcp-session-id");
    let session = sid ? sessions.get(sid) : undefined;
    if (sid && !session) {
      return c.json({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found or terminated; initialize a new session" }, id: null }, 404);
    }
    if (!session) {
      if (sessions.size >= config.remoteMcpMaxSessions) {
        return c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Too many MCP sessions; retry later" }, id: null }, 503);
      }
      const limited = creationLimiter.tryTake(ip);
      if (!limited.ok) {
        const res = c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Too many new MCP sessions from this address" }, id: null }, 429);
        res.headers.set("retry-after", String(Math.max(1, Math.ceil(limited.retryAfterMs / 1000))));
        return res;
      }
      const now = Date.now();
      const state: McpSession = { createdAt: now, lastSeen: now };
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          state.id = id;
          sessions.set(id, state);
        },
        onsessionclosed: (id) => {
          void closeSession(id);
        },
      });
      const server = buildServer(deps, state, index);
      await server.connect(transport);
      state.transport = transport;
      state.server = server;
      session = state;
    }
    session.lastSeen = Date.now();
    const token = bearerToken(c.req.header("authorization")) ?? "";
    return session.transport!.handleRequest(c.req.raw, {
      authInfo: { token, clientId: "odometer-mcp", scopes: [], extra: { ip } },
    });
  });

  const remote: RemoteMcp = {
    async revokeWallet(wallet: string) {
      const ids = [...(byWallet.get(wallet) ?? [])];
      await Promise.all(ids.map((id) => closeSession(id)));
      return ids.length;
    },
    sessionCount: () => sessions.size,
    async close() {
      clearInterval(sweeper);
      await Promise.all([...sessions.keys()].map((id) => closeSession(id)));
    },
  };
  deps.walletRevocationHooks.push(async (wallet) => {
    const closed = await remote.revokeWallet(wallet);
    if (closed) deps.logger.info("revoked MCP sessions", { wallet, closed });
  });
  return remote;
}

type BindingIndex = { bind(state: McpSession, binding: Binding): void; unbind(state: McpSession): void };

function callAuth(extra: { authInfo?: { token?: string; extra?: Record<string, unknown> } }): CallAuth {
  return { token: extra.authInfo?.token ?? "", ip: String(extra.authInfo?.extra?.ip ?? "") };
}

type BindingState = "usable" | "none" | "expired" | "revoked" | "ip_mismatch";

/**
 * A binding is usable only while the wallet is not revoked, it has not expired
 * and the request comes from the IP that paid. Expired or revoked bindings are
 * dropped; an IP mismatch only refuses that request, so a leaked session id
 * cannot be used to tear down the legitimate client's binding.
 */
function bindingState(deps: AppDeps, state: McpSession, ip: string, index: BindingIndex): BindingState {
  const b = state.binding;
  if (!b) return "none";
  if (Date.now() >= b.expiresAt) {
    index.unbind(state);
    return "expired";
  }
  if ((deps.ledger.getAccount(b.wallet)?.sessionEpoch ?? 0) !== b.epoch) {
    index.unbind(state);
    return "revoked";
  }
  if (deps.config.remoteMcpBindIp && b.ip !== ip) return "ip_mismatch";
  return "usable";
}

function buildServer(deps: AppDeps, state: McpSession, index: BindingIndex): McpServer {
  const name = deps.config.serviceName;
  const server = new McpServer(
    { name: name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "solana-rpc", title: name, version: "0.1.0" },
    {
      instructions:
        `${name}: pay-per-call Solana RPC. Before your first call, ask your user how important speed is ` +
        "(economy: free public RPC only; standard: public with automatic Helius fallback; fast: always Helius). " +
        "The first paid call asks for a prepaid USDC top-up over x402; this session may then spend what it paid. " +
        "Send `Authorization: Bearer <session token>` to spend the wallet's full balance instead.",
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
        inputSchema: {
          method: z.string().min(1),
          params: paramsSchema,
          maxPriceUsd: z.number().nonnegative().optional().describe("Refuse the call (not charged) if it costs more than this"),
          idempotencyKey: z.string().min(1).max(128).optional().describe("Retrying with the same key returns the stored result without charging again"),
        },
        annotations: { openWorldHint: true },
      },
      async ({ method, params, maxPriceUsd, idempotencyKey }, extra) =>
        paidCall(deps, state, index, tier, { method, params, maxPriceUsd, idempotencyKey }, extra._meta as Record<string, unknown> | undefined, callAuth(extra)),
    );
  }

  server.registerTool(
    "odometer_balance",
    { title: "Prepaid balance", description: "What this session can spend, and the wallet balance.", inputSchema: {}, annotations: { readOnlyHint: true } },
    async (_args, extra) => {
      const auth = callAuth(extra);
      if (auth.token) {
        const v = deps.sessions.verify(auth.token);
        if (!v.ok) return text({ error: "session_invalid", reason: v.reason }, true);
        return text({ wallet: v.wallet, authority: "session_token", availableUsd: microsToUsd(deps.ledger.available(v.wallet)) });
      }
      if (bindingState(deps, state, auth.ip, index) !== "usable") {
        return text({ message: "Nothing this session may spend; the next paid call asks for a top-up." });
      }
      const b = state.binding!;
      return text({
        wallet: b.wallet,
        authority: "session_voucher",
        sessionSpendableUsd: microsToUsd(Math.min(b.voucherMicros, deps.ledger.available(b.wallet))),
        expiresAt: new Date(b.expiresAt).toISOString(),
      });
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

async function paymentRequired(deps: AppDeps, toolName: string, accepts: PaymentRequirements[], error: string): Promise<ToolResult> {
  const pr = await deps.payments.resourceServer.createPaymentRequiredResponse(
    accepts,
    {
      url: `mcp://tool/${toolName}`,
      description: `Prepaid USDC top-up for ${deps.config.serviceName}; this MCP session may then spend what it paid.`,
      mimeType: "application/json",
    },
    error,
  );
  return { structuredContent: pr as unknown as Record<string, unknown>, content: [{ type: "text", text: JSON.stringify(pr) }], isError: true };
}

interface CallArgs {
  method: string;
  params: unknown;
  maxPriceUsd?: number;
  idempotencyKey?: string;
}

async function paidCall(
  deps: AppDeps,
  state: McpSession,
  index: BindingIndex,
  tier: Tier,
  args: CallArgs,
  meta: Record<string, unknown> | undefined,
  auth: CallAuth,
): Promise<ToolResult> {
  const toolName = `solana_rpc_${tier}`;
  const { method, params } = args;
  const quote = deps.pricing.quote(tier, [method], deps.pricingOptions).items[0]!;
  if (quote.reject) return text({ error: { code: quote.reject.code, message: quote.reject.message } }, true);
  if (args.maxPriceUsd !== undefined && quote.price > usdToMicros(args.maxPriceUsd)) {
    return text({ error: "price_exceeds_max", message: `This call costs $${microsToUsd(quote.price)}; not charged`, priceUsd: microsToUsd(quote.price) }, true);
  }

  // Who may spend, and how much.
  let wallet: string | undefined;
  let viaToken = false;
  if (auth.token) {
    const v = deps.sessions.verify(auth.token);
    if (!v.ok) return text({ error: "session_invalid", reason: v.reason, message: "Sign in again or drop the Authorization header to pay over x402" }, true);
    wallet = v.wallet;
    viaToken = true;
  } else if (bindingState(deps, state, auth.ip, index) === "usable") {
    wallet = state.binding!.wallet;
  }
  const requestHash = sha256Hex(`mcp\n${tier}\n${canonicalJson({ method, params: params ?? null })}`);
  if (wallet) {
    // Neither answer depends on the balance, so neither may turn into a request for money:
    // a response this wallet already paid for, and a call its spending cap rules out.
    const stored = args.idempotencyKey ? deps.ledger.idempotencyPeek(wallet, args.idempotencyKey, requestHash) : undefined;
    if (stored) {
      const replay = JSON.parse(stored.body) as ToolResult;
      return { ...replay, _meta: { ...replay._meta, "odometer/idempotentReplay": true } };
    }
    const block = deps.ledger.dailyCapBlock(wallet, quote.price);
    if (block) {
      return text(
        {
          error: "daily_cap_exceeded",
          message: block.cap === 0 ? "Spending is stopped for this wallet; not charged" : "This wallet reached its daily spend cap; not charged",
        },
        true,
      );
    }
  }
  const spendable = () =>
    wallet ? Math.min(deps.ledger.available(wallet), viaToken ? Number.POSITIVE_INFINITY : (state.binding?.voucherMicros ?? 0)) : 0;

  let settlement: SettleResponse | undefined;
  if (spendable() < quote.price) {
    if (!deps.payments.initialized) {
      try {
        await deps.payments.initialize();
      } catch {
        return text({ error: "payments_unavailable", message: "The payment facilitator is unreachable; retry shortly." }, true);
      }
    }
    const accepts = await deps.payments.buildTopupRequirements();
    const payload = extractPaymentFromMeta({ name: toolName, arguments: { method, params }, _meta: meta });
    if (!payload) {
      return paymentRequired(deps, toolName, accepts, wallet ? "Prepaid balance too low for this session; pay a top-up" : "Payment required: pay a prepaid top-up");
    }
    const match = deps.payments.resourceServer.findMatchingRequirements(accepts, payload);
    if (!match) return paymentRequired(deps, toolName, accepts, "No matching payment requirements");
    let result: SettleResponse;
    try {
      result = await deps.payments.resourceServer.settlePayment(payload, match, {}, { toolName }, undefined, "before-handler");
    } catch (err) {
      deps.logger.warn("mcp settlement error", { error: err instanceof Error ? err.message : String(err) });
      return text(
        {
          error: "settlement_unknown",
          message: "The payment may or may not have settled. It is under review and will be credited if it landed; do not resend it.",
        },
        true,
      );
    }
    if (!result.success || !result.payer) {
      return paymentRequired(deps, toolName, accepts, result.errorReason ?? result.errorMessage ?? "Settlement failed");
    }
    settlement = result;
    deps.counters.topups += 1;
    const paid = atomicToMicros(result.amount ?? match.amount, deps.config.paymentAssetDecimals);
    if (viaToken && result.payer !== wallet) {
      return {
        ...text(
          {
            error: "payer_mismatch",
            message: `The top-up was credited to the paying wallet ${result.payer}, but this session token belongs to ${wallet}. Not charged for the call.`,
          },
          true,
        ),
        _meta: { [MCP_PAYMENT_RESPONSE_META_KEY]: result },
      };
    }
    if (!viaToken) {
      const b = state.binding;
      if (b && b.wallet === result.payer && bindingState(deps, state, auth.ip, index) === "usable") {
        b.voucherMicros += paid;
      } else {
        const now = Date.now();
        index.bind(state, {
          wallet: result.payer,
          epoch: deps.ledger.getAccount(result.payer)?.sessionEpoch ?? 0,
          boundAt: now,
          expiresAt: now + deps.config.remoteMcpSessionTtlSeconds * 1000,
          voucherMicros: paid,
          ip: auth.ip,
        });
      }
    }
    wallet = result.payer;
    if (spendable() < quote.price) {
      return paymentRequired(deps, toolName, accepts, "The top-up does not cover this call; pay a larger one");
    }
  }
  const spender = wallet!;
  const attach = (r: ToolResult): ToolResult => (settlement ? { ...r, _meta: { ...r._meta, [MCP_PAYMENT_RESPONSE_META_KEY]: settlement } } : r);

  const limited = deps.walletLimiter.tryTake(spender);
  if (!limited.ok) return attach(text({ error: "rate_limited", message: "Per-wallet request rate exceeded; not charged" }, true));

  const requestId = newId("req");
  if (args.idempotencyKey) {
    const begin = deps.ledger.idempotencyBegin(spender, args.idempotencyKey, requestHash);
    if (begin.state === "replay") {
      const stored = JSON.parse(begin.body) as ToolResult;
      return attach({ ...stored, _meta: { ...stored._meta, "odometer/idempotentReplay": true } });
    }
    if (begin.state === "in_flight") return attach(text({ error: "idempotency_in_flight", message: "A call with this idempotencyKey is still running" }, true));
    if (begin.state === "mismatch") return attach(text({ error: "idempotency_mismatch", message: "This idempotencyKey was used with different arguments" }, true));
  }
  const receiptKey = args.idempotencyKey ? { wallet: spender, key: args.idempotencyKey, requestId } : undefined;

  // A bare session id spends its voucher, not the wallet. Hold the price now, in the same
  // tick as the check and before any await, so simultaneous calls cannot each pass the
  // check against the same allowance. The unused part is returned when the call resolves.
  const voucher = viaToken ? undefined : state.binding;
  if (!viaToken) {
    if (!voucher || voucher.wallet !== spender || voucher.voucherMicros < quote.price) {
      if (receiptKey) deps.ledger.idempotencyAbort(spender, receiptKey.key);
      return attach(
        await paymentRequired(deps, toolName, await deps.payments.buildTopupRequirements(), "Prepaid balance too low for this session; pay a top-up"),
      );
    }
    voucher.voucherMicros -= quote.price;
  }
  // Returns to the binding that was held, even if the session was rebound meanwhile.
  const returnToVoucher = (amount: number) => {
    if (voucher && amount > 0) voucher.voucherMicros += amount;
  };

  const reservation = deps.ledger.reserve({ wallet: spender, amount: quote.price, tier, methods: [method], requestId });
  if (!reservation.ok) {
    returnToVoucher(quote.price);
    if (receiptKey) deps.ledger.idempotencyAbort(spender, receiptKey.key);
    if (reservation.reason === "daily_cap_exceeded") {
      return attach(text({ error: "daily_cap_exceeded", message: "This wallet reached its daily spend cap; not charged" }, true));
    }
    return attach(await paymentRequired(deps, toolName, await deps.payments.buildTopupRequirements(), "Prepaid balance too low; pay a top-up"));
  }
  let outcome;
  try {
    outcome = await deps.router.execute(
      { jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params: params as unknown[] }) },
      quote,
      { wallet: spender, tier, requestId, deadline: Date.now() + deps.config.timeouts[tier] },
    );
  } catch (err) {
    deps.ledger.release(reservation.reservationId, receiptKey);
    returnToVoucher(quote.price);
    deps.logger.error("mcp call failed", { requestId, error: err });
    return attach(text({ error: "internal_error", requestId }, true));
  }
  const charge = outcome.billable ? quote.price : 0;
  const response = outcome.response as { result?: unknown; error?: unknown };
  const balanceAfter = deps.ledger.available(spender) + quote.price - charge;
  const result: ToolResult = text(
    {
      result: response.result,
      error: response.error,
      cost: { chargedUsd: microsToUsd(charge), balanceUsd: microsToUsd(balanceAfter) },
      routing: { tier, upstreamClass: outcome.upstreamClass, escalated: outcome.escalated, latencyMs: Math.round(outcome.latencyMs) },
      requestId,
    },
    response.error !== undefined,
  );
  // Debit and replay receipt commit together.
  const fin = deps.ledger.finalize(
    reservation.reservationId,
    charge,
    outcome.billable ? 1 : 0,
    receiptKey ? { ...receiptKey, status: 200, headers: {}, body: JSON.stringify(result) } : undefined,
  );
  returnToVoucher(quote.price - fin.charged);
  deps.counters.calls += 1;
  deps.counters.revenueMicros += fin.charged;
  if (outcome.billable) deps.counters.billableCalls += 1;
  return attach(result);
}
