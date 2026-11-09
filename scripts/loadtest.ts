/**
 * Gateway overhead load test (plan requirement before publishing tier claims).
 *
 *   npm run loadtest -- --requests 5000 --concurrency 32
 *
 * Starts an instant mock upstream and the gateway in separate processes,
 * then drives load from this process: once straight at the upstream, once
 * through the gateway's full metered path (session check, rate limits, ledger
 * reserve and finalize on a WAL SQLite file, routing). The difference is the
 * gateway's own overhead on this machine. It says nothing about network
 * latency to real upstreams.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { FacilitatorClient } from "@x402/core/server";
import { loadConfig, SOLANA_DEVNET } from "../src/config.js";
import { createApp } from "../src/server/app.js";
import { silentLogger } from "../src/util/log.js";

const WALLET = "Load111111111111111111111111111111111111111";
const CREDIT = 1_000_000_000;

const facilitatorStub: FacilitatorClient = {
  getSupported: async () => ({
    kinds: [{ x402Version: 2, scheme: "exact", network: SOLANA_DEVNET, extra: { feePayer: "FeePayer11111111111111111111111111111111111" } }],
    extensions: [],
    signers: {},
  }),
  verify: async () => ({ isValid: false, invalidReason: "stub" }),
  settle: async (_p, r) => ({ success: false, errorReason: "stub", transaction: "", network: r.network }),
};

async function runUpstream(): Promise<void> {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"jsonrpc":"2.0","id":1,"result":{"context":{"slot":1000},"value":42}}');
    });
  });
  server.listen(0, "127.0.0.1", () => {
    process.stdout.write(JSON.stringify({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }) + "\n");
  });
}

async function runGateway(upstreamUrl: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "odometer-load-"));
  let handler: ((req: Request) => Response | Promise<Response>) | undefined;
  const server = serve({ fetch: (req) => handler!(req), port: 0, hostname: "127.0.0.1" }, async (info) => {
    const origin = `http://127.0.0.1:${info.port}`;
    const config = loadConfig({
      PUBLIC_ORIGIN: origin,
      DATABASE_PATH: join(dir, "load.db"),
      X402_NETWORK: SOLANA_DEVNET,
      X402_FACILITATOR_URL: "http://127.0.0.1:9/unused",
      PAYTO_ADDRESS: "PayTo111111111111111111111111111111111111111",
      PAYMENT_ASSET: "Mint1111111111111111111111111111111111111111",
      SESSION_SECRET: "load-test-secret-load-test-secret-0123",
      PUBLIC_UPSTREAMS: JSON.stringify([{ id: "mock", url: upstreamUrl, rps: 0 }]),
      WALLET_RPS: "1000000",
      WALLET_DAILY_CAP_USD: "0",
      HEALTH_POLL_MS: "600000",
      LOG_LEVEL: "error",
    });
    const odometer = createApp({ config, logger: silentLogger, facilitator: facilitatorStub });
    handler = odometer.app.fetch;
    odometer.deps.ledger.adjust(WALLET, CREDIT, "load test credit");
    const token = odometer.deps.sessions.issue(WALLET).token;
    odometer.app.get("/__loadtest/ledger", (c) => {
      const account = odometer.deps.ledger.getAccount(WALLET)!;
      return c.json({ balance: account.balance, reserved: account.reserved, reconciled: odometer.deps.ledger.reconcile().ok });
    });
    process.stdout.write(JSON.stringify({ origin, token }) + "\n");
  });
  process.on("SIGTERM", () => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
    process.exit(0);
  });
}

function child(args: string[]): Promise<{ proc: ChildProcess; info: Record<string, string> }> {
  // LOADTEST_PROFILE_DIR=/some/dir writes a CPU profile of the gateway process there.
  const profile = args.includes("gateway") && process.env.LOADTEST_PROFILE_DIR ? ["--cpu-prof", `--cpu-prof-dir=${process.env.LOADTEST_PROFILE_DIR}`] : [];
  const proc = spawn(process.execPath, [...profile, "--import", "tsx", "scripts/loadtest.ts", ...args], {
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: proc.stdout! });
    rl.once("line", (line) => resolve({ proc, info: JSON.parse(line) as Record<string, string> }));
    proc.once("exit", (code) => reject(new Error(`child exited with ${code}`)));
  });
}

function percentile(sorted: number[], q: number): number {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! : 0;
}

async function drive(n: number, concurrency: number, send: () => Promise<number>) {
  const latencies: number[] = [];
  let next = 0;
  let failures = 0;
  const started = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next++ < n) {
        const t0 = performance.now();
        const status = await send();
        latencies.push(performance.now() - t0);
        if (status !== 200) failures += 1;
      }
    }),
  );
  const seconds = (performance.now() - started) / 1000;
  latencies.sort((a, b) => a - b);
  return { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), p99: percentile(latencies, 0.99), rps: n / seconds, failures };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      role: { type: "string" },
      upstream: { type: "string" },
      requests: { type: "string", default: "5000" },
      concurrency: { type: "string", default: "32" },
    },
  });
  if (values.role === "upstream") return runUpstream();
  if (values.role === "gateway") return runGateway(values.upstream!);

  const n = Number(values.requests);
  const concurrency = Number(values.concurrency);
  const upstream = await child(["--role", "upstream"]);
  const gateway = await child(["--role", "gateway", "--upstream", upstream.info.url!]);
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: ["Addr1111111111111111111111111111111111111111"] });
  const post = (url: string, headers: Record<string, string> = {}) => async () => {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
    await res.arrayBuffer();
    return res.status;
  };
  const viaGateway = post(`${gateway.info.origin}/v1/rpc/economy`, { authorization: `Bearer ${gateway.info.token}` });
  try {
    await drive(300, concurrency, post(upstream.info.url!));
    await drive(300, concurrency, viaGateway);
    const direct = await drive(n, concurrency, post(upstream.info.url!));
    const via = await drive(n, concurrency, viaGateway);
    const ledger = (await (await fetch(`${gateway.info.origin}/__loadtest/ledger`)).json()) as {
      balance: number;
      reserved: number;
      reconciled: boolean;
    };
    const f = (x: number) => x.toFixed(2);
    process.stdout.write(`\n${n} requests, concurrency ${concurrency}, Node ${process.version}, separate processes\n\n`);
    process.stdout.write("| path | p50 ms | p95 ms | p99 ms | req/s | non-200 |\n|---|---:|---:|---:|---:|---:|\n");
    process.stdout.write(`| upstream direct | ${f(direct.p50)} | ${f(direct.p95)} | ${f(direct.p99)} | ${Math.round(direct.rps)} | ${direct.failures} |\n`);
    process.stdout.write(`| via gateway (metered) | ${f(via.p50)} | ${f(via.p95)} | ${f(via.p99)} | ${Math.round(via.rps)} | ${via.failures} |\n`);
    process.stdout.write(`| overhead | ${f(via.p50 - direct.p50)} | ${f(via.p95 - direct.p95)} | ${f(via.p99 - direct.p99)} | | |\n\n`);
    process.stdout.write(
      `ledger: ${(CREDIT - ledger.balance) / 10} calls debited at $0.00001 (expected ${n + 300}), reserved ${ledger.reserved}, reconciled ${ledger.reconciled}\n`,
    );
  } finally {
    gateway.proc.kill("SIGTERM");
    upstream.proc.kill("SIGTERM");
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
