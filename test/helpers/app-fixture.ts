import { serve, type ServerType } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import type { FacilitatorClient } from "@x402/core/server";
import { loadConfig, SOLANA_DEVNET } from "../../src/config.js";
import { createApp, type OdometerApp } from "../../src/server/app.js";
import { silentLogger } from "../../src/util/log.js";

export const TEST_PAYTO = "PayTo111111111111111111111111111111111111111";
export const TEST_MINT = "Mint1111111111111111111111111111111111111111";

export interface StartedApp {
  url: string;
  odometer: OdometerApp;
  close(): Promise<void>;
}

/** Boots the real app on a random port with test configuration. */
export async function startApp(env: Record<string, string>, facilitator?: FacilitatorClient): Promise<StartedApp> {
  let handler: ((req: Request) => Response | Promise<Response>) | undefined;
  const server: ServerType = await new Promise((resolve) => {
    const s = serve({ fetch: (req) => handler!(req), port: 0, hostname: "127.0.0.1" }, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  const config = loadConfig({
    PUBLIC_ORIGIN: url,
    DATABASE_PATH: ":memory:",
    X402_NETWORK: SOLANA_DEVNET,
    X402_FACILITATOR_URL: "http://127.0.0.1:1/unused",
    PAYTO_ADDRESS: TEST_PAYTO,
    PAYMENT_ASSET: TEST_MINT,
    SESSION_SECRET: "test-secret-test-secret-test-secret-0123",
    HEALTH_POLL_MS: "60000",
    HELIUS_HEALTH_POLL_MS: "0",
    LOG_LEVEL: "error",
    ADMIN_TOKEN: "admin-token-0123456789",
    ...env,
  });
  const odometer = createApp({ config, logger: silentLogger, facilitator });
  handler = odometer.app.fetch;
  await odometer.deps.payments.initialize();
  await odometer.deps.blockhashes.refresh();
  return {
    url,
    odometer,
    close: async () => {
      await odometer.stop();
      await new Promise<void>((resolve) => {
        (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}
