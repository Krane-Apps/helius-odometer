#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { createKeyPairSignerFromBytes, getBase58Encoder } from "@solana/kit";
import { SOLANA_DEVNET } from "../config.js";
import { createLogger } from "../util/log.js";
import { createFacilitatorApp } from "./server.js";

/** Reads a keypair from a Solana CLI JSON file path, a JSON byte array, or base58. */
export async function loadKeypair(spec: string) {
  const text = spec.trim().startsWith("[") ? spec : spec.includes("/") || spec.endsWith(".json") ? readFileSync(spec, "utf8") : spec;
  const bytes = text.trim().startsWith("[") ? new Uint8Array(JSON.parse(text) as number[]) : new Uint8Array(getBase58Encoder().encode(text.trim()));
  return createKeyPairSignerFromBytes(bytes);
}

async function main(): Promise<void> {
  const keypair = process.env.FACILITATOR_KEYPAIR;
  const rpcUrl = process.env.FACILITATOR_RPC_URL;
  if (!keypair || !rpcUrl) throw new Error("FACILITATOR_KEYPAIR and FACILITATOR_RPC_URL are required");
  const logger = createLogger((process.env.LOG_LEVEL as "info") ?? "info", { service: "odometer-facilitator" });
  const signer = await loadKeypair(keypair);
  const networks = (process.env.FACILITATOR_NETWORKS ?? SOLANA_DEVNET).split(",").map((s) => s.trim());
  const versions = (process.env.FACILITATOR_TX_VERSIONS ?? "0").split(",").map((v) => Number(v.trim()) as 0 | 1);
  const { app } = createFacilitatorApp({ signer, rpcUrl, networks, transactionVersions: versions, logger });
  const port = Number(process.env.FACILITATOR_PORT ?? 8788);
  serve({ fetch: app.fetch, port, hostname: process.env.FACILITATOR_HOST ?? "127.0.0.1" }, (info) =>
    logger.info("facilitator listening", { port: info.port, feePayer: signer.address, networks }),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
