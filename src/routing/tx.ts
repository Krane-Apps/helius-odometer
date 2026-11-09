import { getBase58Decoder, getBase58Encoder } from "@solana/kit";

export interface DecodedTx {
  /** Base58 signature of the first signer: the transaction id. */
  signature: string;
  recentBlockhash: string;
  version: "legacy" | number;
}

const b58decode = getBase58Decoder();
const b58encode = getBase58Encoder();

function readShortVec(bytes: Uint8Array, offset: number): { value: number; offset: number } {
  let value = 0;
  let size = 0;
  for (;;) {
    const byte = bytes[offset + size];
    if (byte === undefined) throw new Error("truncated shortvec");
    value |= (byte & 0x7f) << (7 * size);
    size += 1;
    if ((byte & 0x80) === 0) break;
    if (size > 3) throw new Error("shortvec too long");
  }
  return { value, offset: offset + size };
}

/** Decodes the wire format just enough to get the tx id and its blockhash. */
export function decodeWireTransaction(encoded: string, encoding: "base64" | "base58" = "base64"): DecodedTx {
  const bytes = encoding === "base64" ? new Uint8Array(Buffer.from(encoded, "base64")) : new Uint8Array(b58encode.encode(encoded));
  let { value: sigCount, offset } = readShortVec(bytes, 0);
  if (sigCount < 1) throw new Error("transaction has no signatures");
  const firstSig = bytes.subarray(offset, offset + 64);
  if (firstSig.length !== 64) throw new Error("truncated signature");
  offset += 64 * sigCount;
  let version: DecodedTx["version"] = "legacy";
  const prefix = bytes[offset];
  if (prefix === undefined) throw new Error("truncated message");
  if (prefix & 0x80) {
    version = prefix & 0x7f;
    offset += 1;
  }
  offset += 3; // message header
  const keys = readShortVec(bytes, offset);
  offset = keys.offset + 32 * keys.value;
  const blockhash = bytes.subarray(offset, offset + 32);
  if (blockhash.length !== 32) throw new Error("truncated blockhash");
  return { signature: b58decode.decode(firstSig), recentBlockhash: b58decode.decode(blockhash), version };
}

/** Reads the encoding a sendTransaction call declared (default base58 per the Solana spec). */
export function sendTransactionEncoding(params: unknown[]): "base64" | "base58" {
  const cfg = params[1];
  if (cfg && typeof cfg === "object" && (cfg as { encoding?: unknown }).encoding === "base64") return "base64";
  return "base58";
}
