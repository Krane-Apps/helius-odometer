import { z } from "zod";
import { usdToMicros, type Micros } from "../util/money.js";
import { getMethod, isSubscriptionMethod, type MethodSpec } from "./methods.js";

export const TIERS = ["economy", "standard", "fast"] as const;
export type Tier = (typeof TIERS)[number];

export function isTier(value: string): value is Tier {
  return (TIERS as readonly string[]).includes(value);
}

/** Pricing configuration in USD. Every figure is a starting proposal (see docs/PLAN.md). */
export const PricingConfigSchema = z.object({
  classA: z.object({
    economy: z.number().nonnegative(),
    standard: z.number().nonnegative(),
    fast: z.number().nonnegative(),
  }),
  /** Helius-backed (class B and simulateTransaction) price keyed by Helius credit cost. */
  heliusBackedByCredits: z.record(z.string(), z.number().nonnegative()),
  /** Fallback USD per Helius credit for credit costs missing from the table. */
  heliusBackedPerCredit: z.number().nonnegative(),
  sendTransaction: z.number().nonnegative(),
  /** Helius REST passthrough routes, keyed by route id. */
  rest: z.record(z.string(), z.number().nonnegative()),
  /** Per-method overrides (USD), applied regardless of tier. */
  overrides: z.record(z.string(), z.number().nonnegative()).default({}),
});
export type PricingConfig = z.infer<typeof PricingConfigSchema>;

export const DEFAULT_PRICING: PricingConfig = {
  classA: { economy: 0.00001, standard: 0.00003, fast: 0.00005 },
  heliusBackedByCredits: { "1": 0.00005, "10": 0.0002, "100": 0.002 },
  heliusBackedPerCredit: 0.00002,
  sendTransaction: 0.001,
  rest: { "enhanced-transactions": 0.002, "enhanced-address-history": 0.002 },
  overrides: {},
};

/** Where a priced call is allowed to go. */
export type RoutePlan = "public-only" | "public-first" | "helius";

export interface RejectReason {
  code: number;
  message: string;
  /** HTTP status to use when this is the only item in the request. */
  httpStatus: number;
}

export interface QuoteItem {
  index: number;
  method: string;
  spec?: MethodSpec;
  price: Micros;
  plan?: RoutePlan;
  reject?: RejectReason;
}

export interface Quote {
  tier: Tier;
  items: QuoteItem[];
  total: Micros;
}

export interface PricingOptions {
  /** Tiers that have the infrastructure to serve them. */
  enabledTiers: ReadonlySet<Tier>;
  sendTransactionEnabled: boolean;
  /** False when no Helius upstream is configured: Helius-only methods are then rejected. */
  heliusAvailable: boolean;
}

export const RPC_ERRORS = {
  methodNotFound: { code: -32601, message: "Method not found or not supported by Helius Odometer", httpStatus: 400 },
  blocked: { code: -32050, message: "Method blocked by gateway policy", httpStatus: 403 },
  subscription: {
    code: -32051,
    message: "Subscriptions need a WebSocket connection; the gateway serves HTTP JSON-RPC only",
    httpStatus: 400,
  },
  sendNeedsFast: {
    code: -32052,
    message: "sendTransaction is only available on the fast tier (staked Helius path)",
    httpStatus: 400,
  },
  sendDisabled: {
    code: -32053,
    message: "sendTransaction is disabled on this gateway until the operator enables it",
    httpStatus: 403,
  },
  tierUnavailable: { code: -32054, message: "This tier is not enabled on this gateway", httpStatus: 404 },
  heliusUnavailable: {
    code: -32055,
    message: "This method needs the Helius upstream, which is not configured on this gateway",
    httpStatus: 503,
  },
} as const;

export class Pricing {
  readonly config: PricingConfig;
  private readonly classA: Record<Tier, Micros>;
  private readonly heliusByCredits = new Map<number, Micros>();
  private readonly perCredit: Micros;
  private readonly overrides = new Map<string, Micros>();

  constructor(config: PricingConfig = DEFAULT_PRICING) {
    this.config = PricingConfigSchema.parse(config);
    this.classA = {
      economy: usdToMicros(this.config.classA.economy),
      standard: usdToMicros(this.config.classA.standard),
      fast: usdToMicros(this.config.classA.fast),
    };
    for (const [credits, usd] of Object.entries(this.config.heliusBackedByCredits)) {
      this.heliusByCredits.set(Number(credits), usdToMicros(usd));
    }
    this.perCredit = usdToMicros(this.config.heliusBackedPerCredit);
    for (const [method, usd] of Object.entries(this.config.overrides)) this.overrides.set(method, usdToMicros(usd));
  }

  heliusBackedPrice(credits: number): Micros {
    return this.heliusByCredits.get(credits) ?? Math.max(1, Math.ceil(credits * this.perCredit));
  }

  restPrice(routeId: string): Micros | undefined {
    const usd = this.config.rest[routeId];
    return usd === undefined ? undefined : usdToMicros(usd);
  }

  /** Price and route one method on one tier, or explain why it cannot be served. */
  priceMethod(tier: Tier, method: string, opts: PricingOptions): Omit<QuoteItem, "index"> {
    const spec = getMethod(method);
    if (!spec) {
      return { method, price: 0, reject: isSubscriptionMethod(method) ? RPC_ERRORS.subscription : RPC_ERRORS.methodNotFound };
    }
    if (!opts.enabledTiers.has(tier)) return { method, spec, price: 0, reject: RPC_ERRORS.tierUnavailable };
    const override = this.overrides.get(method);
    switch (spec.cls) {
      case "D":
        return { method, spec, price: 0, reject: RPC_ERRORS.blocked };
      case "C": {
        if (method === "sendTransaction") {
          if (!opts.sendTransactionEnabled) return { method, spec, price: 0, reject: RPC_ERRORS.sendDisabled };
          if (tier !== "fast") return { method, spec, price: 0, reject: RPC_ERRORS.sendNeedsFast };
          return { method, spec, price: override ?? usdToMicros(this.config.sendTransaction), plan: "helius" };
        }
        return { method, spec, price: override ?? this.heliusBackedPrice(spec.credits), plan: "helius" };
      }
      case "B":
        return { method, spec, price: override ?? this.heliusBackedPrice(spec.credits), plan: "helius" };
      case "A": {
        const plan: RoutePlan = tier === "economy" ? "public-only" : tier === "standard" ? "public-first" : "helius";
        return { method, spec, price: override ?? this.classA[tier] * spec.weight, plan };
      }
    }
  }

  quote(tier: Tier, methods: readonly string[], opts: PricingOptions): Quote {
    const items = methods.map((method, index) => {
      const item: QuoteItem = { index, ...this.priceMethod(tier, method, opts) };
      if (!item.reject && item.plan === "helius" && !opts.heliusAvailable) {
        return { ...item, price: 0, plan: undefined, reject: RPC_ERRORS.heliusUnavailable };
      }
      return item;
    });
    const total = items.reduce((sum, item) => sum + (item.reject ? 0 : item.price), 0);
    return { tier, items, total };
  }
}
