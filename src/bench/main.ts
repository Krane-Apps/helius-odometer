#!/usr/bin/env node
/**
 * odometer-bench: measure candidate upstreams before publishing any tier target.
 *
 *   odometer-bench --upstream solana=https://api.mainnet-beta.solana.com \
 *                  --upstream helius="https://mainnet.helius-rpc.com/?api-key=$HELIUS_API_KEY" \
 *                  --duration 60 --rps 2 --methods getSlot,getLatestBlockhash,getBalance \
 *                  --out bench.json
 *
 * Keep --rps within each provider's published free-tier limits.
 */
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parseCalls, runBench, toMarkdown } from "./bench.js";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      upstream: { type: "string", multiple: true },
      duration: { type: "string", default: "30" },
      rps: { type: "string", default: "2" },
      timeout: { type: "string", default: "8000" },
      methods: { type: "string", default: "getSlot,getLatestBlockhash,getBalance,getAccountInfo" },
      address: { type: "string", default: "Vote111111111111111111111111111111111111111" },
      out: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help || !values.upstream?.length) {
    process.stdout.write("usage: odometer-bench --upstream name=url [--upstream name=url ...] [--duration s] [--rps n] [--methods a,b] [--out file.json]\n");
    process.exit(values.help ? 0 : 1);
  }
  const targets = values.upstream.map((spec, i) => {
    const eq = spec.indexOf("=");
    return eq > 0 ? { id: spec.slice(0, eq), url: spec.slice(eq + 1) } : { id: `upstream-${i + 1}`, url: spec };
  });
  const report = await runBench({
    targets,
    calls: parseCalls(values.methods.split(",").map((s) => s.trim()).filter(Boolean), values.address),
    durationMs: Number(values.duration) * 1000,
    rps: Number(values.rps),
    timeoutMs: Number(values.timeout),
    slotPollMs: 1000,
    onProgress: (ms) => process.stderr.write(`\r${Math.round(ms / 1000)}s`),
  });
  process.stderr.write("\n");
  if (values.out) writeFileSync(values.out, JSON.stringify(report, null, 2));
  process.stdout.write(toMarkdown(report));
}

main().catch((err) => {
  process.stderr.write(`odometer-bench: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
