import { describe, expect, it } from "vitest";
import {
  appendTransactionMessageInstruction,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Blockhash,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { prepareParams, responseSlot, SlotHighWaterMarks, TxSessions } from "../../src/routing/consistency.js";
import { decodeWireTransaction, sendTransactionEncoding } from "../../src/routing/tx.js";
import { getMethod } from "../../src/pricing/methods.js";
import { parseJsonRpcBody } from "../../src/routing/jsonrpc.js";

const spec = (name: string) => {
  const s = getMethod(name);
  if (!s) throw new Error(name);
  return s;
};

describe("prepareParams", () => {
  it("appends a config object when the caller passed none", () => {
    const out = prepareParams(spec("getSlot"), undefined, { commitment: "confirmed" });
    expect(out.params).toEqual([{ commitment: "confirmed" }]);
    expect(out.effectiveCommitment).toBe("confirmed");
  });

  it("does not mutate the caller's params", () => {
    const params = ["Addr", { encoding: "base64" }];
    const out = prepareParams(spec("getAccountInfo"), params, { commitment: "confirmed", minContextSlot: () => 10 });
    expect(params).toEqual(["Addr", { encoding: "base64" }]);
    expect(out.params).toEqual(["Addr", { encoding: "base64", commitment: "confirmed", minContextSlot: 10 }]);
  });

  it("leaves legacy string config and missing positional params alone", () => {
    expect(prepareParams(spec("getTransaction"), ["sig", "json"], { commitment: "confirmed" }).params).toEqual(["sig", "json"]);
    expect(prepareParams(spec("getBlocksWithLimit"), [5], { commitment: "confirmed" }).params).toEqual([5]);
  });

  it("only injects commitment where the catalog allows it", () => {
    const out = prepareParams(spec("getTransaction"), ["sig"], { commitment: "confirmed" });
    expect(out.params).toEqual(["sig"]);
    expect(out.effectiveCommitment).toBe("finalized");
  });

  it("keys minContextSlot floors by commitment", () => {
    const hwm = new SlotHighWaterMarks(2, 1000);
    hwm.observe("w", "processed", 500, 0);
    hwm.observe("w", "confirmed", 470, 0);
    const out = prepareParams(spec("getBalance"), ["A", { commitment: "confirmed" }], {
      minContextSlot: (c) => hwm.floor("w", c, 10),
    });
    expect(out.params).toEqual(["A", { commitment: "confirmed", minContextSlot: 468 }]);
    expect(hwm.floor("w", "confirmed", 2000)).toBeUndefined();
  });

  it("reads response slots", () => {
    expect(responseSlot(spec("getBalance"), { context: { slot: 77 }, value: 1 })).toBe(77);
    expect(responseSlot(spec("getSlot"), 88)).toBe(88);
    expect(responseSlot(spec("getBlockHeight"), 99)).toBeUndefined();
  });

  it("tracks transaction sessions with a TTL", () => {
    const s = new TxSessions(1000);
    s.touch("w", 0);
    expect(s.active("w", 500)).toBe(true);
    expect(s.active("w", 1500)).toBe(false);
  });
});

describe("decodeWireTransaction", () => {
  it("extracts the signature and blockhash from a signed v0 transaction", async () => {
    const payer = await generateKeyPairSigner();
    const to = await generateKeyPairSigner();
    const blockhash = getBase58Decoder().decode(new Uint8Array(32).fill(7)) as Blockhash;
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(payer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight: 100n }, m),
      (m) => appendTransactionMessageInstruction(getTransferSolInstruction({ source: payer, destination: to.address, amount: 1n }), m),
    );
    const signed = await signTransactionMessageWithSigners(message);
    const wire = getBase64EncodedWireTransaction(signed);
    const decoded = decodeWireTransaction(wire, "base64");
    expect(decoded.signature).toBe(getSignatureFromTransaction(signed));
    expect(decoded.recentBlockhash).toBe(blockhash);
    expect(decoded.version).toBe(0);
    expect(sendTransactionEncoding([wire, { encoding: "base64" }])).toBe("base64");
    expect(sendTransactionEncoding([wire])).toBe("base58");
    expect(() => decodeWireTransaction("AA==", "base64")).toThrow();
  });
});

describe("parseJsonRpcBody", () => {
  it("validates single and batch bodies", () => {
    expect(parseJsonRpcBody({ jsonrpc: "2.0", id: 1, method: "getSlot" }, 5)).toMatchObject({ ok: true, batch: false });
    expect(parseJsonRpcBody([], 5)).toMatchObject({ ok: false, httpStatus: 400 });
    expect(parseJsonRpcBody(new Array(6).fill({ jsonrpc: "2.0", id: 1, method: "getSlot" }), 5)).toMatchObject({
      ok: false,
      httpStatus: 413,
    });
    const mixed = parseJsonRpcBody([{ jsonrpc: "2.0", id: 1, method: "getSlot" }, { id: 2 }], 5);
    expect(mixed.ok && "invalid" in mixed.requests[1]!).toBe(true);
    expect(parseJsonRpcBody({ jsonrpc: "1.0", id: 1, method: "x" }, 5)).toMatchObject({ ok: false });
    expect(parseJsonRpcBody({ jsonrpc: "2.0", id: {}, method: "x" }, 5)).toMatchObject({ ok: false });
  });
});
