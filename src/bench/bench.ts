import { Upstream, type CallOutcome } from "../routing/upstream.js";

/**
 * Phase 0 measurement: before any tier promises a latency, measure the real
 * upstreams from the hosting region. Per upstream and method this records
 * p50/p95/p99 latency, error and 429 rates, and slot lag versus the best
 * upstream observed at the same moment.
 */
export interface BenchTarget {
  id: string;
  url: string;
}

export interface BenchCall {
  method: string;
  params?: unknown[];
}

export interface BenchOptions {
  targets: BenchTarget[];
  calls: BenchCall[];
  durationMs: number;
  /** Requests per second per upstream (paced). */
  rps: number;
  timeoutMs: number;
  /** Interval for the parallel getSlot polls that measure slot lag. */
  slotPollMs: number;
  onProgress?: (elapsedMs: number) => void;
}

export interface MethodStats {
  method: string;
  count: number;
  ok: number;
  rpcErrors: number;
  httpErrors: number;
  rateLimited: number;
  timeouts: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  errorCodes: Record<string, number>;
}

export interface TargetReport {
  id: string;
  url: string;
  methods: MethodStats[];
  slotLag: { samples: number; avg: number; p95: number; max: number; unreachable: number };
}

export interface BenchReport {
  startedAt: string;
  durationMs: number;
  rps: number;
  targets: TargetReport[];
}

class Recorder {
  readonly latencies: number[] = [];
  count = 0;
  ok = 0;
  rpcErrors = 0;
  httpErrors = 0;
  rateLimited = 0;
  timeouts = 0;
  readonly errorCodes: Record<string, number> = {};

  add(out: CallOutcome): void {
    this.count += 1;
    switch (out.kind) {
      case "ok":
        if ("error" in out.body && out.body.error) {
          this.rpcErrors += 1;
          const code = String(out.body.error.code);
          this.errorCodes[code] = (this.errorCodes[code] ?? 0) + 1;
        } else {
          this.ok += 1;
          this.latencies.push(out.latencyMs);
        }
        break;
      case "rate-limited":
        this.rateLimited += 1;
        break;
      case "timeout":
        this.timeouts += 1;
        break;
      default:
        this.httpErrors += 1;
        this.errorCodes[out.kind] = (this.errorCodes[out.kind] ?? 0) + 1;
    }
  }
}

export function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runBench(opts: BenchOptions): Promise<BenchReport> {
  if (opts.targets.length === 0) throw new Error("no targets");
  if (opts.calls.length === 0) throw new Error("no calls");
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const deadline = started + opts.durationMs;
  const upstreams = opts.targets.map((t) => new Upstream({ id: t.id, url: t.url, rps: 0, denyMethods: [], weight: 1, kind: "public" }));
  const recorders = upstreams.map(() => new Map<string, Recorder>(opts.calls.map((c) => [c.method, new Recorder()])));
  const lagSamples = upstreams.map(() => [] as number[]);
  const unreachable = upstreams.map(() => 0);

  const load = upstreams.map(async (u, i) => {
    const interval = 1000 / Math.max(0.1, opts.rps);
    let n = 0;
    const inflight = new Set<Promise<void>>();
    while (Date.now() < deadline) {
      const call = opts.calls[n % opts.calls.length]!;
      const due = started + n * interval;
      n += 1;
      const wait = due - Date.now();
      if (wait > 0) await sleep(wait);
      if (Date.now() >= deadline) break;
      const p = u
        .call({ jsonrpc: "2.0", id: n, method: call.method, ...(call.params ? { params: call.params } : {}) }, opts.timeoutMs)
        .then((out) => recorders[i]!.get(call.method)!.add(out));
      inflight.add(p);
      void p.finally(() => inflight.delete(p));
    }
    await Promise.all(inflight);
  });

  const lag = (async () => {
    while (Date.now() < deadline) {
      const slots = await Promise.all(
        upstreams.map(async (u) => {
          const out = await u.call({ jsonrpc: "2.0", id: 1, method: "getSlot", params: [{ commitment: "confirmed" }] }, opts.timeoutMs);
          return out.kind === "ok" && "result" in out.body && typeof out.body.result === "number" ? out.body.result : undefined;
        }),
      );
      const best = Math.max(...slots.filter((s): s is number => s !== undefined));
      slots.forEach((s, i) => {
        if (s === undefined || !Number.isFinite(best)) unreachable[i]! += 1;
        else lagSamples[i]!.push(best - s);
      });
      opts.onProgress?.(Date.now() - started);
      await sleep(opts.slotPollMs);
    }
  })();

  await Promise.all([...load, lag]);

  return {
    startedAt,
    durationMs: Date.now() - started,
    rps: opts.rps,
    targets: upstreams.map((u, i) => ({
      id: u.id,
      url: redact(u.url),
      methods: [...recorders[i]!.entries()].map(([method, r]) => ({
        method,
        count: r.count,
        ok: r.ok,
        rpcErrors: r.rpcErrors,
        httpErrors: r.httpErrors,
        rateLimited: r.rateLimited,
        timeouts: r.timeouts,
        p50Ms: percentile(r.latencies, 0.5),
        p95Ms: percentile(r.latencies, 0.95),
        p99Ms: percentile(r.latencies, 0.99),
        errorCodes: r.errorCodes,
      })),
      slotLag: {
        samples: lagSamples[i]!.length,
        avg: lagSamples[i]!.length ? Math.round((lagSamples[i]!.reduce((a, b) => a + b, 0) / lagSamples[i]!.length) * 10) / 10 : 0,
        p95: percentile(lagSamples[i]!, 0.95),
        max: lagSamples[i]!.length ? Math.max(...lagSamples[i]!) : 0,
        unreachable: unreachable[i]!,
      },
    })),
  };
}

/** Hides API keys in URLs before they reach a report. */
export function redact(url: string): string {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) {
      if (/key|token|secret/i.test(key)) u.searchParams.set(key, "REDACTED");
    }
    return u.toString();
  } catch {
    return url;
  }
}

export function toMarkdown(report: BenchReport): string {
  const lines = [
    `# Upstream benchmark`,
    ``,
    `Started ${report.startedAt}, ${Math.round(report.durationMs / 1000)}s at ${report.rps} req/s per upstream.`,
    ``,
    `| Upstream | Method | Calls | OK | p50 ms | p95 ms | p99 ms | 429 | Timeouts | Errors |`,
    `|---|---|---:|---:|---:|---:|---:|---:|---:|---:|`,
  ];
  for (const t of report.targets) {
    for (const m of t.methods) {
      const errors = m.rpcErrors + m.httpErrors;
      lines.push(`| ${t.id} | ${m.method} | ${m.count} | ${m.ok} | ${m.p50Ms} | ${m.p95Ms} | ${m.p99Ms} | ${m.rateLimited} | ${m.timeouts} | ${errors} |`);
    }
  }
  lines.push(``, `| Upstream | Slot lag avg | p95 | max | unreachable polls |`, `|---|---:|---:|---:|---:|`);
  for (const t of report.targets) {
    lines.push(`| ${t.id} | ${t.slotLag.avg} | ${t.slotLag.p95} | ${t.slotLag.max} | ${t.slotLag.unreachable} |`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Parses `getBalance:<address>` style method specs into calls. Every built-in
 * workload pins `confirmed`, so upstreams and tiers are compared at the same
 * commitment (an upstream default of `finalized` would lag by ~13 s).
 */
export function parseCalls(specs: string[], address: string): BenchCall[] {
  return specs.map((spec) => {
    const [method, arg] = spec.split(":") as [string, string | undefined];
    const target = arg ?? address;
    switch (method) {
      case "getBalance":
        return { method, params: [target, { commitment: "confirmed" }] };
      case "getAccountInfo":
        return { method, params: [target, { encoding: "base64", commitment: "confirmed" }] };
      case "getSignaturesForAddress":
        return { method, params: [target, { limit: 10, commitment: "confirmed" }] };
      case "getTokenAccountsByOwner":
        return { method, params: [target, { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" }, { encoding: "jsonParsed", commitment: "confirmed" }] };
      case "getLatestBlockhash":
      case "getSlot":
      case "getBlockHeight":
        return { method, params: [{ commitment: "confirmed" }] };
      default:
        return arg ? { method, params: [arg] } : { method };
    }
  });
}
