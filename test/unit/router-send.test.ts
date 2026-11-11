import { afterEach, describe, expect, it } from "vitest";
import { startMockRpc, type MockRpc } from "../helpers/mock-rpc.js";
import { buildRouter } from "../helpers/router-fixture.js";
import { Pricing, type Tier } from "../../src/pricing/pricing.js";
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
import { Rebroadcaster } from "../../src/routing/rebroadcast.js";
import { silentLogger } from "../../src/util/log.js";

const pricing = new Pricing();
const opts = { enabledTiers: new Set<Tier>(["fast"]), sendTransactionEnabled: true, heliusAvailable: true };

describe("Router sendTransaction preflight", () => {
  const servers: MockRpc[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });

  async function send(params: unknown[]) {
    const hel = await startMockRpc(() => ({ result: "sig" }));
    servers.push(hel);
    const f = buildRouter({ publics: [], helius: { url: hel.url } });
    const q = pricing.priceMethod("fast", "sendTransaction", opts);
    const out = await f.router.execute({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params }, { index: 0, ...q }, {
      wallet: "w",
      tier: "fast",
      requestId: "r",
      deadline: Date.now() + 5000,
    });
    return { out, sentParams: hel.calls[0]!.params };
  }

  it("defaults preflightCommitment to confirmed when the caller set none", async () => {
    const { out, sentParams } = await send(["AQ==", { encoding: "base64" }]);
    expect(sentParams).toEqual(["AQ==", { encoding: "base64", preflightCommitment: "confirmed" }]);
    expect(out.injected).toEqual({ commitment: "confirmed" });
  });

  it("adds a config object when the caller passed only the transaction", async () => {
    const { sentParams } = await send(["base58tx"]);
    expect(sentParams).toEqual(["base58tx", { preflightCommitment: "confirmed" }]);
  });

  it("never overrides an explicit choice or a skipped preflight", async () => {
    expect((await send(["AQ==", { preflightCommitment: "finalized" }])).sentParams).toEqual([
      "AQ==",
      { preflightCommitment: "finalized" },
    ]);
    const skipped = await send(["AQ==", { skipPreflight: true }]);
    expect(skipped.sentParams).toEqual(["AQ==", { skipPreflight: true }]);
    expect(skipped.out.injected).toBeUndefined();
  });
});

/**
 * The documented rebroadcast route: resends go to the upstream that accepted the
 * transaction (Helius RPC, or Sender when the caller chose it); status and
 * blockhash reads always go to Helius RPC, because Sender only takes sends.
 */
describe("Router sendTransaction rebroadcast route", () => {
  const servers: MockRpc[] = [];
  const rebroadcasters: Rebroadcaster[] = [];
  afterEach(async () => {
    for (const r of rebroadcasters.splice(0)) r.stop();
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });

  async function signedTransfer() {
    const payer = await generateKeyPairSigner();
    const to = await generateKeyPairSigner();
    const blockhash = getBase58Decoder().decode(new Uint8Array(32).fill(9)) as Blockhash;
    const signed = await signTransactionMessageWithSigners(
      pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(payer, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight: 100n }, m),
        (m) => appendTransactionMessageInstruction(getTransferSolInstruction({ source: payer, destination: to.address, amount: 1n }), m),
      ),
    );
    return { wire: getBase64EncodedWireTransaction(signed), signature: getSignatureFromTransaction(signed), blockhash };
  }
  const until = async (cond: () => boolean) => {
    const deadline = Date.now() + 3000;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  async function setup(sendVia: "sender" | "rpc", rebroadcast = true) {
    const tx = await signedTransfer();
    let confirmed = false;
    const hel = await startMockRpc((method) => {
      if (method === "getSignatureStatuses") return { result: { context: { slot: 1 }, value: [confirmed ? { confirmationStatus: "confirmed", err: null } : null] } };
      if (method === "isBlockhashValid") return { result: { context: { slot: 1 }, value: true } };
      return { result: tx.signature };
    });
    const snd = await startMockRpc(() => ({ result: tx.signature }));
    servers.push(hel, snd);
    const rebroadcaster = new Rebroadcaster(silentLogger, { intervalMs: 15, maxSeconds: 5, maxJobs: 10 });
    rebroadcasters.push(rebroadcaster);
    const f = buildRouter({ publics: [], helius: { url: hel.url }, sender: { url: snd.url }, rebroadcaster });
    const q = pricing.priceMethod("fast", "sendTransaction", opts);
    const out = await f.router.execute(
      { jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [tx.wire, { encoding: "base64", skipPreflight: true }] },
      { index: 0, ...q },
      { wallet: "w", tier: "fast", requestId: "r", deadline: Date.now() + 5000, sendVia, rebroadcast },
    );
    expect(out.billable).toBe(true);
    return { tx, hel, snd, rebroadcaster, confirm: () => (confirmed = true) };
  }

  it("resends through Helius RPC by default, with the same bytes, until confirmed", async () => {
    const { tx, hel, snd, rebroadcaster, confirm } = await setup("rpc");
    await until(() => hel.callsFor("sendTransaction").length >= 3);
    for (const resend of hel.callsFor("sendTransaction").slice(1)) {
      expect(resend.params).toEqual([tx.wire, { encoding: "base64", skipPreflight: true, maxRetries: 0 }]);
    }
    expect(hel.callsFor("getSignatureStatuses")[0]!.params).toEqual([[tx.signature]]);
    expect(snd.calls).toHaveLength(0);
    confirm();
    await until(() => rebroadcaster.active === 0);
    const sent = hel.callsFor("sendTransaction").length;
    await new Promise((r) => setTimeout(r, 80));
    expect(hel.callsFor("sendTransaction").length).toBe(sent);
  });

  it("resends through Sender when the call used Sender, and reads status from Helius RPC", async () => {
    const { tx, hel, snd, rebroadcaster, confirm } = await setup("sender");
    await until(() => snd.callsFor("sendTransaction").length >= 3);
    expect(snd.callsFor("sendTransaction")[1]!.params).toEqual([tx.wire, { encoding: "base64", skipPreflight: true, maxRetries: 0 }]);
    // Sender only ever sees sends; Helius RPC only ever sees reads.
    expect(snd.calls.every((c) => c.method === "sendTransaction")).toBe(true);
    expect(hel.callsFor("sendTransaction")).toHaveLength(0);
    expect(hel.callsFor("getSignatureStatuses").length).toBeGreaterThan(0);
    confirm();
    await until(() => rebroadcaster.active === 0);
  });

  it("does not resend unless the caller asked", async () => {
    const { hel, rebroadcaster } = await setup("rpc", false);
    expect(rebroadcaster.active).toBe(0);
    await new Promise((r) => setTimeout(r, 80));
    expect(hel.callsFor("sendTransaction")).toHaveLength(1);
  });
});
