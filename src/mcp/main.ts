#!/usr/bin/env node
/**
 * Stdio MCP bridge for Helius Odometer.
 *
 *   ODOMETER_URL            gateway origin (required)
 *   ODOMETER_WALLET_KEY     keypair file path, JSON byte array or base58 secret key (required)
 *   ODOMETER_MAX_TOPUP_USD  largest single top-up allowed (default 5)
 *   ODOMETER_MAX_SPEND_USD  total top-ups allowed per process (default 20)
 *   ODOMETER_TOPUP_USD      preferred top-up denomination
 *   ODOMETER_AUTO_TOPUP     "false" to never pay automatically
 *   ODOMETER_ALLOWED_ASSETS comma list of extra payment mints (test mints only)
 *
 * stdout carries the MCP protocol; diagnostics go to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { OdometerClient } from "../client/index.js";
import { loadKeypair } from "../util/keypair.js";
import { createOdometerMcpServer, type GatewayIndex } from "./server.js";

function num(name: string): number | undefined {
  const v = process.env[name];
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`);
  return n;
}

async function main(): Promise<void> {
  const baseUrl = process.env.ODOMETER_URL;
  const key = process.env.ODOMETER_WALLET_KEY;
  if (!baseUrl || !key) throw new Error("ODOMETER_URL and ODOMETER_WALLET_KEY are required");
  const signer = await loadKeypair(key);
  const indexRes = await fetch(baseUrl.replace(/\/+$/, "") + "/");
  if (!indexRes.ok) throw new Error(`could not reach the gateway at ${baseUrl} (${indexRes.status})`);
  const index = (await indexRes.json()) as GatewayIndex;
  const allowed = (process.env.ODOMETER_ALLOWED_ASSETS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((asset) => ({ network: index.network, asset }));
  const client = new OdometerClient({
    baseUrl,
    signer,
    autoTopup: process.env.ODOMETER_AUTO_TOPUP !== "false",
    maxTopupUsd: num("ODOMETER_MAX_TOPUP_USD") ?? 5,
    maxSpendUsd: num("ODOMETER_MAX_SPEND_USD") ?? 20,
    topupUsd: num("ODOMETER_TOPUP_USD"),
    allowedAssets: allowed.length ? allowed : undefined,
  });
  const server = createOdometerMcpServer(client, index);
  await server.connect(new StdioServerTransport());
  process.stderr.write(`helius-odometer MCP ready: wallet ${signer.address}, tiers ${index.tiers.map((t) => t.tier).join(",")}\n`);
}

main().catch((err) => {
  process.stderr.write(`odometer-mcp: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
