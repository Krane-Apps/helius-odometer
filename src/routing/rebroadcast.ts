import type { Logger } from "../util/log.js";
import type { Upstream } from "./upstream.js";

interface Job {
  signature: string;
  rawTx: string;
  encoding: "base64" | "base58";
  blockhash: string;
  /** Where the transaction was first sent, and where every resend goes. */
  upstream: Upstream;
  /** Where status and blockhash are read. Helius Sender only accepts sendTransaction, so reads need an RPC endpoint. */
  statusUpstream: Upstream;
  startedAt: number;
  iterations: number;
}

/**
 * Optional server-side resend loop for sendTransaction: re-submits the same
 * signed bytes to the upstream that accepted them (Helius RPC, or Helius
 * Sender when the call used it) until the signature confirms, its blockhash
 * expires, or the time budget ends. Re-sending identical bytes is idempotent
 * on-chain; a resend never goes to a route the caller did not choose.
 */
export class Rebroadcaster {
  private readonly jobs = new Map<string, Job>();
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly logger: Logger,
    private readonly opts: { intervalMs: number; maxSeconds: number; maxJobs: number },
  ) {}

  get active(): number {
    return this.jobs.size;
  }

  start(job: Omit<Job, "startedAt" | "iterations">): boolean {
    if (this.jobs.has(job.signature)) return true;
    if (this.jobs.size >= this.opts.maxJobs) return false;
    this.jobs.set(job.signature, { ...job, startedAt: Date.now(), iterations: 0 });
    if (!this.timer) {
      this.timer = setInterval(() => void this.tick(), this.opts.intervalMs);
      this.timer.unref();
    }
    return true;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.jobs.clear();
  }

  private async tick(): Promise<void> {
    if (this.jobs.size === 0) {
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
      return;
    }
    await Promise.all([...this.jobs.values()].map((job) => this.step(job)));
  }

  private async step(job: Job): Promise<void> {
    const now = Date.now();
    if (now - job.startedAt > this.opts.maxSeconds * 1000) return this.finish(job, "time budget exhausted");
    job.iterations += 1;
    const status = await job.statusUpstream.call(
      { jsonrpc: "2.0", id: 1, method: "getSignatureStatuses", params: [[job.signature]] },
      3000,
    );
    if (status.kind === "ok" && "result" in status.body) {
      const value = (status.body.result as { value?: Array<{ confirmationStatus?: string; err?: unknown } | null> })?.value?.[0];
      if (value && (value.err || value.confirmationStatus === "confirmed" || value.confirmationStatus === "finalized")) {
        return this.finish(job, value.err ? "landed with error" : "confirmed");
      }
    }
    if (job.iterations % 5 === 0) {
      const valid = await job.statusUpstream.call(
        { jsonrpc: "2.0", id: 1, method: "isBlockhashValid", params: [job.blockhash, { commitment: "processed" }] },
        3000,
      );
      if (valid.kind === "ok" && "result" in valid.body) {
        const v = (valid.body.result as { value?: boolean })?.value;
        if (v === false) return this.finish(job, "blockhash expired");
      }
    }
    if (!job.upstream.tryTake("send")) return;
    await job.upstream.call(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "sendTransaction",
        params: [job.rawTx, { encoding: job.encoding, skipPreflight: true, maxRetries: 0 }],
      },
      3000,
    );
  }

  private finish(job: Job, reason: string): void {
    this.jobs.delete(job.signature);
    this.logger.debug("rebroadcast finished", { signature: job.signature, reason, iterations: job.iterations });
  }
}
