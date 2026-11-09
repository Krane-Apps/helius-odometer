import { existsSync, readFileSync } from "node:fs";
import { createKeyPairSignerFromBytes, getBase58Encoder, type KeyPairSigner } from "@solana/kit";

/**
 * Loads a Solana keypair from any of the usual forms:
 *  - a path to a Solana CLI keypair file (JSON array of 64 bytes)
 *  - an inline JSON array of 64 bytes
 *  - a base58-encoded 64-byte secret key (Phantom-style export)
 */
export async function loadKeypair(spec: string): Promise<KeyPairSigner> {
  const value = spec.trim();
  let bytes: Uint8Array;
  if (value.startsWith("[")) {
    bytes = new Uint8Array(JSON.parse(value) as number[]);
  } else if (existsSync(value)) {
    bytes = new Uint8Array(JSON.parse(readFileSync(value, "utf8")) as number[]);
  } else {
    bytes = new Uint8Array(getBase58Encoder().encode(value));
  }
  if (bytes.length !== 64) throw new Error(`expected a 64-byte secret key, got ${bytes.length} bytes`);
  return createKeyPairSignerFromBytes(bytes);
}
