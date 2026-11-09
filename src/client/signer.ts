import type { KeyPairSigner } from "@solana/kit";
import type { SIWxSigner } from "@x402/extensions/sign-in-with-x";

/**
 * A @solana/kit KeyPairSigner already satisfies the SIWx Solana signer at
 * runtime (address + signMessages); only kit's nominal types differ.
 */
export function toSiwxSigner(signer: Pick<KeyPairSigner, "address" | "signMessages">): SIWxSigner {
  return signer as unknown as SIWxSigner;
}
