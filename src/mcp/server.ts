import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { OdometerClient, OdometerError, type Tier } from "../client/index.js";
import { BILLING_SUMMARY } from "../pricing/billing.js";

export interface GatewayIndex {
  /** The gateway's public name (its SERVICE_NAME). */
  name?: string;
  network: string;
  topupOptionsUsd: number[];
  tiers: Array<{ tier: Tier; endpoint: string; description: string }>;
}

const SPEED_GUIDANCE =
  "Before your first Solana call in a task, ask your user how important speed is: " +
  "economy is cheapest (free public RPC only), standard falls back to Helius automatically, fast always uses Helius.";

const toUsd = (micros: number | undefined) => (micros === undefined ? undefined : (micros / 1_000_000).toFixed(6).replace(/0+$/, "").replace(/\.$/, ""));

function text(value: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], isError };
}

function describeError(err: unknown) {
  if (err instanceof OdometerError) return text({ error: err.code, message: err.message, details: err.details }, true);
  return text({ error: "unexpected", message: err instanceof Error ? err.message : String(err) }, true);
}

/**
 * A local (stdio) MCP server that exposes Helius Odometer as tools. The
 * wallet key stays in this process; the gateway only ever sees signatures.
 * One tool per tier so the agent makes an explicit, user-informed speed choice.
 */
export function createOdometerMcpServer(client: OdometerClient, index: GatewayIndex, fetchImpl: typeof fetch = fetch): McpServer {
  const name = index.name ?? "Helius Odometer";
  const server = new McpServer(
    { name: "helius-odometer", version: "0.1.0" },
    {
      instructions:
        `${name}: pay-per-call Solana RPC paid from this wallet's prepaid USDC balance (${client.wallet}). ` +
        `${SPEED_GUIDANCE} Top-ups happen automatically within the configured spend limits. ` +
        "Use odometer_pricing to check what a method costs and odometer_balance to see what is left.",
    },
  );

  const paramsSchema = z
    .union([z.array(z.unknown()), z.record(z.string(), z.unknown())])
    .optional()
    .describe("Positional params array (most Solana methods) or a named params object (DAS methods such as getAsset)");

  for (const { tier, description } of index.tiers) {
    server.registerTool(
      `solana_rpc_${tier}`,
      {
        title: `Solana RPC (${tier} tier)`,
        description: `${description} ${SPEED_GUIDANCE} Each call is debited from the prepaid balance. ${BILLING_SUMMARY}`,
        inputSchema: {
          method: z.string().min(1).describe("Solana JSON-RPC or Helius DAS method, e.g. getBalance, getAccountInfo, getAsset"),
          params: paramsSchema,
        },
        annotations: { openWorldHint: true },
      },
      async ({ method, params }) => {
        try {
          const r = await client.rpc(method, params, { tier });
          return text(
            {
              result: r.result,
              error: r.error,
              cost: { chargedUsd: toUsd(r.meta.chargedMicros), balanceUsd: toUsd(r.meta.balanceMicros) },
              routing: {
                tier,
                upstreamClass: r.meta.upstreamClass,
                escalated: r.meta.escalated,
                latencyMs: r.meta.latencyMs,
                contextSlot: r.meta.contextSlot,
              },
              topup: r.meta.topup,
            },
            r.error !== undefined,
          );
        } catch (err) {
          return describeError(err);
        }
      },
    );
  }

  server.registerTool(
    "odometer_balance",
    {
      title: `${name} balance`,
      description: "Prepaid balance, daily cap and totals for this wallet.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        return text(await client.balance());
      } catch (err) {
        return describeError(err);
      }
    },
  );

  server.registerTool(
    "odometer_pricing",
    {
      title: `${name} pricing`,
      description: "Price per call for each tier. Pass a method name to see just that method.",
      inputSchema: { method: z.string().optional().describe("Optional method name to filter, e.g. getAsset") },
      annotations: { readOnlyHint: true },
    },
    async ({ method }) => {
      try {
        const res = await fetchImpl(`${client.baseUrl}/pricing`);
        const doc = (await res.json()) as { methods: Array<{ method: string }>; [k: string]: unknown };
        if (method) {
          const m = doc.methods.find((x) => x.method === method);
          return m ? text(m) : text({ error: "unknown_method", message: `${method} is not served by this gateway` }, true);
        }
        return text({ ...doc, methods: `${doc.methods.length} methods; pass a method name for details` });
      } catch (err) {
        return describeError(err);
      }
    },
  );

  server.registerTool(
    "odometer_topup",
    {
      title: `Top up ${name} balance`,
      description: `Pay a USDC top-up now. Options: ${index.topupOptionsUsd.map((u) => `$${u}`).join(", ")}. Respects the configured spend limits.`,
      inputSchema: { usd: z.number().positive().describe("Top-up amount in USD; must be one of the offered options") },
    },
    async ({ usd }) => {
      try {
        return text(await client.topup(usd));
      } catch (err) {
        return describeError(err);
      }
    },
  );

  return server;
}
