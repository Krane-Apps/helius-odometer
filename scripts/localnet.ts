/**
 * One-command local environment for Helius Odometer.
 *
 *   npm run localnet            # start everything and keep running
 *   npm run localnet -- --demo  # also run a scripted agent session, then exit
 *
 * Starts solana-test-validator, creates a 6-decimal test "USDC" mint, funds a
 * demo agent wallet, runs the local x402 facilitator, a Helius stand-in
 * (the validator plus canned DAS answers) and the gateway. Nothing touches
 * mainnet and no real funds are involved.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { createKeyPairSignerFromPrivateKeyBytes, generateKeyPairSigner, getBase58Encoder, type KeyPairSigner } from "@solana/kit";
import { loadConfig, SOLANA_DEVNET } from "../src/config.js";
import { createApp } from "../src/server/app.js";
import { createFacilitatorApp } from "../src/facilitator/server.js";
import { OdometerClient } from "../src/client/index.js";
import { createLogger, silentLogger } from "../src/util/log.js";
import { startHeliusProxy } from "../dev/helius-proxy.js";
import { airdrop, createAta, createMint, localRpc, mintTo, startValidator, tokenBalance } from "../dev/localnet.js";

const USDC = 1_000_000n;

async function exportableSigner(): Promise<{ signer: KeyPairSigner; secret: number[] }> {
  const seed = new Uint8Array(randomBytes(32));
  const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
  return { signer, secret: [...seed, ...getBase58Encoder().encode(signer.address)] };
}

function listen(fetchHandler: (req: Request) => Response | Promise<Response>, port: number): Promise<ServerType> {
  return new Promise((resolve) => {
    const s = serve({ fetch: fetchHandler, port, hostname: "127.0.0.1" }, () => resolve(s));
  });
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      demo: { type: "boolean", default: false },
      port: { type: "string", default: "8787" },
      verbose: { type: "boolean", default: false },
    },
  });
  const dir = join(process.cwd(), ".localnet");
  mkdirSync(dir, { recursive: true });
  const say = (msg: string) => process.stdout.write(`${msg}\n`);

  say("starting solana-test-validator ...");
  const validator = await startValidator();
  const rpc = localRpc(validator.rpcUrl);
  const mintAuthority = await generateKeyPairSigner();
  const feePayer = await generateKeyPairSigner();
  const operator = await generateKeyPairSigner();
  const agent = await exportableSigner();
  await Promise.all([airdrop(rpc, mintAuthority.address, 10), airdrop(rpc, feePayer.address, 10), airdrop(rpc, agent.signer.address, 2)]);
  const mint = await createMint(rpc, mintAuthority, 6);
  await createAta(rpc, mintAuthority, operator.address, mint);
  await mintTo(rpc, mintAuthority, mint, agent.signer.address, 1000n * USDC);
  writeFileSync(join(dir, "agent.json"), JSON.stringify(agent.secret));

  const logger = values.verbose ? createLogger("info") : silentLogger;
  const { app: facilitatorApp } = createFacilitatorApp({
    signer: feePayer,
    rpcUrl: validator.rpcUrl,
    networks: [SOLANA_DEVNET],
    transactionVersions: [0],
    logger,
  });
  const facilitator = await listen(facilitatorApp.fetch, 0);
  const facilitatorUrl = `http://127.0.0.1:${(facilitator.address() as AddressInfo).port}`;
  const helius = await startHeliusProxy(validator.rpcUrl);

  const port = Number(values.port);
  const origin = `http://127.0.0.1:${port}`;
  const adminToken = randomBytes(16).toString("hex");
  const config = loadConfig({
    PORT: String(port),
    PUBLIC_ORIGIN: origin,
    DATABASE_PATH: join(dir, "odometer.db"),
    X402_NETWORK: SOLANA_DEVNET,
    X402_FACILITATOR_URL: facilitatorUrl,
    PAYTO_ADDRESS: operator.address,
    PAYMENT_ASSET: mint,
    PUBLIC_UPSTREAMS: JSON.stringify([{ id: "localnet", url: validator.rpcUrl, rps: 0 }]),
    HELIUS_RPC_URL: helius.url,
    ENABLE_SEND_TRANSACTION: "true",
    SESSION_SECRET: randomBytes(32).toString("hex"),
    ADMIN_TOKEN: adminToken,
    LOG_LEVEL: values.verbose ? "info" : "error",
  });
  const odometer = createApp({ config, logger });
  odometer.start();
  const gateway = await listen(odometer.app.fetch, port);
  await odometer.deps.payments.initialize();

  say("");
  say("Helius Odometer localnet is up");
  say(`  gateway       ${origin}`);
  say(`  validator     ${validator.rpcUrl} (${validator.mode})`);
  say(`  facilitator   ${facilitatorUrl} (fee payer ${feePayer.address})`);
  say(`  helius        ${helius.url} (stand-in: validator + canned DAS)`);
  say(`  test USDC     ${mint}`);
  say(`  operator      ${operator.address} (receives top-ups)`);
  say(`  agent wallet  ${agent.signer.address} (1000 test USDC, key in .localnet/agent.json)`);
  say(`  admin token   ${adminToken}`);
  say("");
  say("Try it:");
  say(`  curl -i -X POST ${origin}/v1/rpc/economy -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getSlot"}'`);
  say("");
  say("MCP (Claude Code):");
  say(
    `  claude mcp add helius-odometer -e ODOMETER_URL=${origin} -e ODOMETER_WALLET_KEY=${join(dir, "agent.json")} -e ODOMETER_ALLOWED_ASSETS=${mint} -- npx tsx ${join(process.cwd(), "src/mcp/main.ts")}`,
  );
  say("");

  const shutdown = async () => {
    await new Promise<void>((r) => gateway.close(() => r()));
    await odometer.stop();
    await helius.close();
    await new Promise<void>((r) => facilitator.close(() => r()));
    await validator.stop();
  };

  if (values.demo) {
    await runDemo(origin, agent.signer, mint, operator.address, rpc);
    await shutdown();
    return;
  }
  say("Ctrl-C to stop.");
  process.on("SIGINT", () => void shutdown().then(() => process.exit(0)));
  process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)));
}

async function runDemo(origin: string, agent: KeyPairSigner, mint: string, operator: string, rpc: ReturnType<typeof localRpc>) {
  const say = (msg: string) => process.stdout.write(`${msg}\n`);
  const client = new OdometerClient({
    baseUrl: origin,
    signer: agent,
    maxTopupUsd: 5,
    maxSpendUsd: 10,
    allowedAssets: [{ network: SOLANA_DEVNET, asset: mint }],
  });
  const usdc = async (owner: string) => Number(await tokenBalance(rpc, owner as never, mint as never)) / 1e6;
  say("Demo agent session");
  say(`  on-chain before: agent ${await usdc(agent.address)} USDC, operator ${await usdc(operator)} USDC`);
  const calls: Array<[string, unknown, "economy" | "standard" | "fast"]> = [
    ["getSlot", undefined, "economy"],
    ["getBalance", [agent.address], "economy"],
    ["getLatestBlockhash", undefined, "standard"],
    ["getBalance", [agent.address], "fast"],
    ["getAsset", { id: "demo-asset" }, "economy"],
  ];
  say("");
  say("  | tier | method | charged (USD) | balance (USD) | upstream | paid top-up |");
  say("  |---|---|---:|---:|---|---|");
  for (const [method, params, tier] of calls) {
    const r = await client.rpc(method, params, { tier });
    const usd = (m?: number) => (m === undefined ? "" : (m / 1e6).toString());
    say(`  | ${tier} | ${method} | ${usd(r.meta.chargedMicros)} | ${usd(r.meta.balanceMicros)} | ${r.meta.upstreamClass} | ${r.meta.topup ? r.meta.topup.transaction.slice(0, 12) + "..." : ""} |`);
  }
  say("");
  say(`  on-chain after:  agent ${await usdc(agent.address)} USDC, operator ${await usdc(operator)} USDC`);
  say(`  one on-chain payment, ${calls.length} calls served from the prepaid balance`);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
