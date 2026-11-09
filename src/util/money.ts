/**
 * All balances and prices are integer "micros": millionths of one USD, which is
 * exactly one atomic unit of a 6-decimal stablecoin such as USDC. Integer math
 * keeps the ledger exact; floats only appear at the configuration boundary.
 */
export type Micros = number;

export const MICROS_PER_USD = 1_000_000;

export function usdToMicros(usd: number | string): Micros {
  const n = typeof usd === "string" ? Number(usd.replace(/^\$/, "")) : usd;
  if (!Number.isFinite(n) || n < 0) throw new Error(`invalid USD amount: ${String(usd)}`);
  return Math.round(n * MICROS_PER_USD);
}

export function microsToUsd(micros: Micros): string {
  const sign = micros < 0 ? "-" : "";
  const abs = Math.abs(micros);
  const whole = Math.floor(abs / MICROS_PER_USD);
  const frac = String(abs % MICROS_PER_USD).padStart(6, "0").replace(/0+$/, "");
  return `${sign}${whole}${frac ? "." + frac : ""}`;
}

/** Converts micros to atomic units of an asset with the given decimals. */
export function microsToAtomic(micros: Micros, decimals: number): bigint {
  if (decimals >= 6) return BigInt(micros) * 10n ** BigInt(decimals - 6);
  const div = 10n ** BigInt(6 - decimals);
  return BigInt(micros) / div;
}

/** Converts atomic units of an asset with the given decimals to micros (floored). */
export function atomicToMicros(atomic: bigint | string, decimals: number): Micros {
  const a = typeof atomic === "string" ? BigInt(atomic) : atomic;
  if (decimals >= 6) return Number(a / 10n ** BigInt(decimals - 6));
  return Number(a * 10n ** BigInt(6 - decimals));
}
