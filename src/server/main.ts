#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { enabledTiers, loadConfig } from "../config.js";
import { createLogger } from "../util/log.js";
import { createApp } from "./app.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel, { service: "helius-odometer" });
  const tiers = [...enabledTiers(config)];
  if (config.sessionSecretGenerated) {
    logger.warn("SESSION_SECRET not set: generated a random one; sessions will not survive a restart");
  }
  if (!config.helius) logger.warn("no Helius upstream configured (HELIUS_API_KEY or HELIUS_RPC_URL): fast tier disabled");
  if (config.publicUpstreams.length === 0) {
    logger.warn("no PUBLIC_UPSTREAMS configured: economy and standard tiers disabled");
  }
  if (tiers.length === 0) throw new Error("No tier can be served: configure HELIUS_API_KEY and/or PUBLIC_UPSTREAMS");

  const odometer = createApp({ config, logger, onWriterLockLost: () => process.exit(1) });
  odometer.start();
  const server = serve({ fetch: odometer.app.fetch, port: config.port, hostname: config.host }, (info) => {
    logger.info("helius-odometer listening", {
      address: `${info.address}:${info.port}`,
      publicOrigin: config.publicOrigin,
      network: config.network,
      tiers,
      sendTransaction: config.sendTransactionEnabled,
    });
  });

  const shutdown = (signal: string) => {
    logger.info("shutting down", { signal });
    server.close(() => {
      void odometer.stop().then(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
