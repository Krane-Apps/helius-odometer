import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { DEFAULT_PRICING, PricingConfigSchema, type PricingConfig, type Tier } from "./pricing/pricing.js";
import type { Commitment } from "./pricing/methods.js";
import type { LogLevel } from "./util/log.js";

export const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";

/** USDC mint per CAIP-2 network. */
export const USDC_MINTS: Record<string, string> = {
  [SOLANA_MAINNET]: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  [SOLANA_DEVNET]: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
};

export interface UpstreamConfig {
  id: string;
  url: string;
  kind: "public" | "helius";
  /** Requests per second this gateway may send (token bucket). 0 = unlimited. */
  rps: number;
  /** Methods this upstream refuses; they are skipped without a request. */
  denyMethods: string[];
  /** Selection weight among healthy upstreams of the same kind. */
  weight: number;
}

export interface Config {
  host: string;
  port: number;
  publicOrigin: string;
  databasePath: string;
  logLevel: LogLevel;
  trustProxy: boolean;

  network: string;
  facilitatorUrl: string;
  facilitatorAuthHeader?: string;
  payTo: string;
  paymentAsset: string;
  paymentAssetDecimals: number;
  topupOptionsUsd: number[];
  maxTimeoutSeconds: number;

  sessionSecret: string;
  sessionSecretGenerated: boolean;
  sessionTtlSeconds: number;

  helius?: UpstreamConfig;
  heliusSenderUrl?: string;
  heliusApiBase?: string;
  heliusApiKey?: string;
  heliusSendRps: number;
  heliusHeavyRps: number;
  publicUpstreams: UpstreamConfig[];

  sendTransactionEnabled: boolean;
  rebroadcastMaxSeconds: number;
  pricing: PricingConfig;
  maxBatch: number;
  maxBodyBytes: number;
  walletRps: number;
  ipRps: number;
  walletDailyCapUsd: number;
  defaultCommitment: Record<Tier, Commitment | undefined>;
  minContextSlotMargin: number;

  healthPollMs: number;
  heliusHealthPollMs: number;
  maxSlotLag: number;
  timeouts: Record<Tier, number>;
  publicAttemptTimeoutMs: number;
  maxPublicAttempts: number;

  adminToken?: string;
  bootstrapEnabled: boolean;
}

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? fallback : ["1", "true", "yes", "on"].includes(v.toLowerCase())));

const int = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === "") return fallback;
      const n = Number(v);
      if (!Number.isFinite(n)) {
        ctx.addIssue({ code: "custom", message: `expected a number, got ${v}` });
        return z.NEVER;
      }
      return n;
    });

const EnvSchema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: int(8787),
  PUBLIC_ORIGIN: z.string().optional(),
  DATABASE_PATH: z.string().default("./data/odometer.db"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  TRUST_PROXY: bool(false),

  X402_NETWORK: z.string().default(SOLANA_MAINNET),
  X402_FACILITATOR_URL: z.string().url(),
  X402_FACILITATOR_AUTH_HEADER: z.string().optional(),
  PAYTO_ADDRESS: z.string().min(32).max(44),
  PAYMENT_ASSET: z.string().optional(),
  PAYMENT_ASSET_DECIMALS: int(6),
  TOPUP_OPTIONS_USD: z.string().default("1,5,20"),
  X402_MAX_TIMEOUT_SECONDS: int(120),

  SESSION_SECRET: z.string().optional(),
  SESSION_TTL_SECONDS: int(1800),

  HELIUS_RPC_URL: z.string().url().optional(),
  HELIUS_API_KEY: z.string().optional(),
  HELIUS_RPS: int(50),
  HELIUS_SEND_TX_RPS: int(5),
  HELIUS_HEAVY_RPS: int(10),
  HELIUS_SENDER_URL: z.string().url().optional(),
  HELIUS_API_BASE: z.string().url().optional(),
  PUBLIC_UPSTREAMS: z.string().optional(),

  ENABLE_SEND_TRANSACTION: bool(false),
  REBROADCAST_MAX_SECONDS: int(60),
  PRICING_FILE: z.string().optional(),
  MAX_BATCH: int(25),
  MAX_BODY_BYTES: int(262_144),
  WALLET_RPS: int(25),
  IP_RPS: int(20),
  WALLET_DAILY_CAP_USD: int(10),
  ECONOMY_COMMITMENT: z.enum(["processed", "confirmed", "finalized", "none"]).default("confirmed"),
  STANDARD_COMMITMENT: z.enum(["processed", "confirmed", "finalized", "none"]).default("confirmed"),
  FAST_COMMITMENT: z.enum(["processed", "confirmed", "finalized", "none"]).default("none"),
  MIN_CONTEXT_SLOT_MARGIN: int(4),

  HEALTH_POLL_MS: int(2000),
  HELIUS_HEALTH_POLL_MS: int(30_000),
  MAX_SLOT_LAG: int(50),
  ECONOMY_TIMEOUT_MS: int(8000),
  STANDARD_TIMEOUT_MS: int(10_000),
  FAST_TIMEOUT_MS: int(15_000),
  PUBLIC_ATTEMPT_TIMEOUT_MS: int(2500),
  MAX_PUBLIC_ATTEMPTS: int(2),

  ADMIN_TOKEN: z.string().min(16).optional(),
  BOOTSTRAP_RPC_ENABLED: bool(true),
});

const PublicUpstreamSchema = z.object({
  id: z.string().min(1),
  url: z.string().url(),
  rps: z.number().nonnegative().default(5),
  denyMethods: z.array(z.string()).default([]),
  weight: z.number().positive().default(1),
});

/** Parses PUBLIC_UPSTREAMS: either JSON (array of objects) or a comma list of URLs. */
export function parsePublicUpstreams(raw: string | undefined): UpstreamConfig[] {
  if (!raw || !raw.trim()) return [];
  const text = raw.trim();
  const entries: unknown[] = text.startsWith("[")
    ? (JSON.parse(text) as unknown[])
    : text.split(",").map((url, i) => ({ id: `public-${i + 1}`, url: url.trim() }));
  return entries.map((entry) => {
    const parsed = PublicUpstreamSchema.parse(entry);
    return { ...parsed, kind: "public" as const };
  });
}

export function heliusRpcUrl(env: { HELIUS_RPC_URL?: string; HELIUS_API_KEY?: string }): string | undefined {
  if (env.HELIUS_RPC_URL) return env.HELIUS_RPC_URL;
  if (env.HELIUS_API_KEY) return `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(env.HELIUS_API_KEY)}`;
  return undefined;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const e = parsed.data;

  const paymentAsset = e.PAYMENT_ASSET ?? USDC_MINTS[e.X402_NETWORK];
  if (!paymentAsset) {
    throw new Error(`PAYMENT_ASSET is required for network ${e.X402_NETWORK} (no default USDC mint known)`);
  }

  const topupOptionsUsd = e.TOPUP_OPTIONS_USD.split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  if (topupOptionsUsd.length === 0) throw new Error("TOPUP_OPTIONS_USD must contain at least one positive amount");

  let sessionSecret = e.SESSION_SECRET;
  let sessionSecretGenerated = false;
  if (!sessionSecret) {
    sessionSecret = randomBytes(32).toString("hex");
    sessionSecretGenerated = true;
  } else if (sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET must be at least 32 characters");
  }

  let pricing = DEFAULT_PRICING;
  if (e.PRICING_FILE) {
    const raw = JSON.parse(readFileSync(e.PRICING_FILE, "utf8")) as Partial<PricingConfig>;
    pricing = PricingConfigSchema.parse({ ...DEFAULT_PRICING, ...raw });
  }

  const heliusUrl = heliusRpcUrl(e);
  const helius: UpstreamConfig | undefined = heliusUrl
    ? { id: "helius", url: heliusUrl, kind: "helius", rps: e.HELIUS_RPS, denyMethods: [], weight: 1 }
    : undefined;

  const commitment = (v: string): Commitment | undefined => (v === "none" ? undefined : (v as Commitment));
  const publicOrigin = (e.PUBLIC_ORIGIN ?? `http://localhost:${e.PORT}`).replace(/\/+$/, "");

  return {
    host: e.HOST,
    port: e.PORT,
    publicOrigin,
    databasePath: e.DATABASE_PATH,
    logLevel: e.LOG_LEVEL,
    trustProxy: e.TRUST_PROXY,
    network: e.X402_NETWORK,
    facilitatorUrl: e.X402_FACILITATOR_URL,
    facilitatorAuthHeader: e.X402_FACILITATOR_AUTH_HEADER,
    payTo: e.PAYTO_ADDRESS,
    paymentAsset,
    paymentAssetDecimals: e.PAYMENT_ASSET_DECIMALS,
    topupOptionsUsd,
    maxTimeoutSeconds: e.X402_MAX_TIMEOUT_SECONDS,
    sessionSecret,
    sessionSecretGenerated,
    sessionTtlSeconds: e.SESSION_TTL_SECONDS,
    helius,
    heliusSenderUrl: e.HELIUS_SENDER_URL,
    heliusApiBase: e.HELIUS_API_BASE ?? (e.HELIUS_API_KEY ? "https://api-mainnet.helius-rpc.com" : undefined),
    heliusApiKey: e.HELIUS_API_KEY,
    heliusSendRps: e.HELIUS_SEND_TX_RPS,
    heliusHeavyRps: e.HELIUS_HEAVY_RPS,
    publicUpstreams: parsePublicUpstreams(e.PUBLIC_UPSTREAMS),
    sendTransactionEnabled: e.ENABLE_SEND_TRANSACTION,
    rebroadcastMaxSeconds: e.REBROADCAST_MAX_SECONDS,
    pricing,
    maxBatch: e.MAX_BATCH,
    maxBodyBytes: e.MAX_BODY_BYTES,
    walletRps: e.WALLET_RPS,
    ipRps: e.IP_RPS,
    walletDailyCapUsd: e.WALLET_DAILY_CAP_USD,
    defaultCommitment: {
      economy: commitment(e.ECONOMY_COMMITMENT),
      standard: commitment(e.STANDARD_COMMITMENT),
      fast: commitment(e.FAST_COMMITMENT),
    },
    minContextSlotMargin: e.MIN_CONTEXT_SLOT_MARGIN,
    healthPollMs: e.HEALTH_POLL_MS,
    heliusHealthPollMs: e.HELIUS_HEALTH_POLL_MS,
    maxSlotLag: e.MAX_SLOT_LAG,
    timeouts: { economy: e.ECONOMY_TIMEOUT_MS, standard: e.STANDARD_TIMEOUT_MS, fast: e.FAST_TIMEOUT_MS },
    publicAttemptTimeoutMs: e.PUBLIC_ATTEMPT_TIMEOUT_MS,
    maxPublicAttempts: e.MAX_PUBLIC_ATTEMPTS,
    adminToken: e.ADMIN_TOKEN,
    bootstrapEnabled: e.BOOTSTRAP_RPC_ENABLED,
  };
}

/** Tiers that can actually behave differently given the configured upstreams. */
export function enabledTiers(config: Pick<Config, "helius" | "publicUpstreams">): Set<Tier> {
  const tiers = new Set<Tier>();
  if (config.helius) tiers.add("fast");
  if (config.publicUpstreams.length > 0) {
    tiers.add("economy");
    if (config.helius) tiers.add("standard");
  }
  return tiers;
}
