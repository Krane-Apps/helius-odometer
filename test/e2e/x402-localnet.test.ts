/**
 * End-to-end: a real solana-test-validator, a real SPL "USDC" mint, the
 * official x402 SVM facilitator, the gateway and an agent wallet. Payments
 * move tokens on-chain; nothing is mocked except Helius (a proxy to the same
 * validator that also answers DAS calls).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve, type ServerType } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import {
  appendTransactionMessageInstruction,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type KeyPairSigner,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { wrapFetchWithPayment, x402Client, x402HTTPClient } from "@x402/fetch";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { createSIWxClientExtension } from "@x402/extensions/sign-in-with-x";
import { SOLANA_DEVNET } from "../../src/config.js";
import { OdometerClient, toSiwxSigner } from "../../src/client/index.js";
import { createFacilitatorApp } from "../../src/facilitator/server.js";
import { silentLogger } from "../../src/util/log.js";
import { startApp, type StartedApp } from "../helpers/app-fixture.js";
import { startHeliusProxy, type HeliusProxy } from "./helius-proxy.js";
import {
  airdrop,
  createAta,
  createMint,
  localRpc,
  mintTo,
  startValidator,
  tokenBalance,
  validatorAvailable,
  type Rpc,
  type Validator,
} from "./localnet.js";

const USDC = 1_000_000n;
const run = validatorAvailable() ? describe : describe.skip;

run("x402 end-to-end on a local validator", () => {
  let validator: Validator;
  let rpc: Rpc;
  let mint: Address;
  let operator: KeyPairSigner;
  let agent: KeyPairSigner;
  let facilitatorServer: ServerType;
  let helius: HeliusProxy;
  let gw: StartedApp;
  let client: OdometerClient;

  beforeAll(async () => {
    validator = await startValidator();
    rpc = localRpc(validator.rpcUrl);
    const mintAuthority = await generateKeyPairSigner();
    const feePayer = await generateKeyPairSigner();
    operator = await generateKeyPairSigner();
    agent = await generateKeyPairSigner();
    await Promise.all([airdrop(rpc, mintAuthority.address, 10), airdrop(rpc, feePayer.address, 10), airdrop(rpc, agent.address, 1)]);
    mint = await createMint(rpc, mintAuthority, 6);
    await createAta(rpc, mintAuthority, operator.address, mint);
    await mintTo(rpc, mintAuthority, mint, agent.address, 100n * USDC);

    const { app } = createFacilitatorApp({
      signer: feePayer,
      rpcUrl: validator.rpcUrl,
      networks: [SOLANA_DEVNET],
      transactionVersions: [0],
      logger: silentLogger,
    });
    facilitatorServer = await new Promise((resolve) => {
      const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
    });
    const facilitatorUrl = `http://127.0.0.1:${(facilitatorServer.address() as AddressInfo).port}`;

    helius = await startHeliusProxy(validator.rpcUrl);
    gw = await startApp({
      X402_FACILITATOR_URL: facilitatorUrl,
      PAYTO_ADDRESS: operator.address,
      PAYMENT_ASSET: mint,
      PUBLIC_UPSTREAMS: JSON.stringify([{ id: "localnet", url: validator.rpcUrl, rps: 0 }]),
      HELIUS_RPC_URL: helius.url,
      ENABLE_SEND_TRANSACTION: "true",
      WALLET_RPS: "1000",
      IP_RPS: "1000",
      LOG_LEVEL: "error",
    });
    client = new OdometerClient({
      baseUrl: gw.url,
      signer: agent,
      tier: "economy",
      maxTopupUsd: 5,
      maxSpendUsd: 10,
      allowedAssets: [{ network: SOLANA_DEVNET, asset: mint }],
    });
  });

  afterAll(async () => {
    await gw?.close();
    await helius?.close();
    await new Promise<void>((r) => (facilitatorServer ? facilitatorServer.close(() => r()) : r()));
    await validator?.stop();
  });

  it("pays a USDC top-up on-chain on the first call and serves it", async () => {
    const agentBefore = await tokenBalance(rpc, agent.address, mint);
    const operatorBefore = await tokenBalance(rpc, operator.address, mint);
    const { result, meta } = await client.rpc<number>("getSlot");
    expect(typeof result).toBe("number");
    expect(meta.status).toBe(200);
    expect(meta.topup?.transaction).toBeTruthy();
    expect(meta.topup?.payer).toBe(agent.address);
    expect(meta.chargedMicros).toBe(10);
    expect(meta.balanceMicros).toBe(999_990);
    expect(await tokenBalance(rpc, agent.address, mint)).toBe(agentBefore - USDC);
    expect(await tokenBalance(rpc, operator.address, mint)).toBe(operatorBefore + USDC);
    const tx = await rpc
      .getTransaction(meta.topup!.transaction as never, { commitment: "confirmed", maxSupportedTransactionVersion: 0, encoding: "json" })
      .send();
    expect(tx?.meta?.err).toBeNull();
  });

  it("debits later calls from the balance with no new on-chain payment", async () => {
    const operatorBefore = await tokenBalance(rpc, operator.address, mint);
    let last = 0;
    for (let i = 0; i < 5; i++) {
      const { meta } = await client.rpc("getLatestBlockhash");
      expect(meta.topup).toBeUndefined();
      last = meta.balanceMicros!;
    }
    expect(last).toBe(999_990 - 5 * 10);
    expect(await tokenBalance(rpc, operator.address, mint)).toBe(operatorBefore);
  });

  it("returns real chain data through each tier with honest routing headers", async () => {
    const lamports = (await rpc.getBalance(agent.address, { commitment: "confirmed" }).send()).value;
    const econ = await client.rpc<{ value: number }>("getBalance", [agent.address], { tier: "economy" });
    expect(BigInt(econ.result!.value)).toBe(lamports);
    expect(econ.meta.upstreamClass).toBe("public");
    const fast = await client.rpc<{ value: number }>("getBalance", [agent.address], { tier: "fast" });
    expect(BigInt(fast.result!.value)).toBe(lamports);
    expect(fast.meta.upstreamClass).toBe("helius");
    expect(fast.meta.chargedMicros).toBe(50);
    const das = await client.rpc<{ source: string }>("getAsset", { id: "asset-1" }, { tier: "economy" });
    expect(das.result?.source).toBe("helius-proxy");
    expect(das.meta.chargedMicros).toBe(200);
  });

  it("lands a transaction on the fast tier and pins its status reads to Helius", async () => {
    const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(agent, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => appendTransactionMessageInstruction(getTransferSolInstruction({ source: agent, destination: operator.address, amount: 2_000_000n }), m),
    );
    const signed = await signTransactionMessageWithSigners(message);
    const expected = getSignatureFromTransaction(signed);
    const sent = await client.rpc<string>("sendTransaction", [getBase64EncodedWireTransaction(signed), { encoding: "base64" }], { tier: "fast" });
    expect(sent.error, JSON.stringify(sent.error)).toBeUndefined();
    expect(sent.result).toBe(expected);
    expect(sent.meta.chargedMicros).toBe(1000);
    let confirmed = false;
    for (let i = 0; i < 60 && !confirmed; i++) {
      const st = await client.rpc<{ value: Array<{ confirmationStatus?: string } | null> }>("getSignatureStatuses", [[expected]], { tier: "standard" });
      expect(st.meta.upstreamClass).toBe("helius");
      confirmed = ["confirmed", "finalized"].includes(st.result?.value[0]?.confirmationStatus ?? "");
      if (!confirmed) await new Promise((r) => setTimeout(r, 250));
    }
    expect(confirmed).toBe(true);
    expect(helius.calls).toContain("sendTransaction");
  });

  it("works with a stock x402 client: SIWx first, then pays, then reuses the wallet balance", async () => {
    const agent2 = await generateKeyPairSigner();
    const authority = await generateKeyPairSigner();
    await airdrop(rpc, authority.address, 1);
    // A fresh mint authority cannot mint the existing mint, so fund agent2 from agent instead.
    void authority;
    await client.rpc("getSlot");
    const { getTransferCheckedInstruction } = await import("@solana-program/token");
    const { sendInstructions, ata } = await import("./localnet.js");
    await createAta(rpc, agent, agent2.address, mint);
    await sendInstructions(rpc, agent, [
      getTransferCheckedInstruction({
        source: await ata(agent.address, mint),
        mint,
        destination: await ata(agent2.address, mint),
        authority: agent,
        amount: 3n * USDC,
        decimals: 6,
      }),
    ]);

    const stock = new x402Client().register("solana:*", new ExactSvmScheme(agent2, { rpcUrl: validator.rpcUrl, transactionVersions: [0] }));
    stock.setSpendControls({ allowedAssets: [{ network: SOLANA_DEVNET, asset: mint }] });
    stock.registerExtension(createSIWxClientExtension({ signers: [toSiwxSigner(agent2)] }));
    const paidFetch = wrapFetchWithPayment(fetch, new x402HTTPClient(stock));
    const call = () =>
      paidFetch(`${gw.url}/v1/rpc/economy`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot" }),
      });
    const before = await tokenBalance(rpc, agent2.address, mint);
    const first = await call();
    expect(first.status).toBe(200);
    expect(first.headers.get("payment-response")).toBeTruthy();
    expect(await tokenBalance(rpc, agent2.address, mint)).toBe(before - USDC);
    const second = await call();
    expect(second.status).toBe(200);
    expect(second.headers.get("payment-response")).toBeNull();
    expect(await tokenBalance(rpc, agent2.address, mint)).toBe(before - USDC);
    expect(gw.odometer.deps.ledger.available(agent2.address)).toBe(1_000_000 - 20);
  });

  it("refuses to credit a replayed payment twice", async () => {
    const payer = await generateKeyPairSigner();
    const { getTransferCheckedInstruction } = await import("@solana-program/token");
    const { sendInstructions, ata } = await import("./localnet.js");
    await createAta(rpc, agent, payer.address, mint);
    await sendInstructions(rpc, agent, [
      getTransferCheckedInstruction({
        source: await ata(agent.address, mint),
        mint,
        destination: await ata(payer.address, mint),
        authority: agent,
        amount: 2n * USDC,
        decimals: 6,
      }),
    ]);
    const url = `${gw.url}/v1/rpc/economy`;
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot" });
    const r402 = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
    const pr = decodePaymentRequiredHeader(r402.headers.get("payment-required")!);
    const xc = new x402Client()
      .register("solana:*", new ExactSvmScheme(payer, { rpcUrl: validator.rpcUrl, transactionVersions: [0] }))
      .setSpendControls({ allowedAssets: [{ network: SOLANA_DEVNET, asset: mint }] });
    const payload = await xc.createPaymentPayload({ ...pr, accepts: [pr.accepts[0]!] });
    const header = encodePaymentSignatureHeader(payload);
    const before = await tokenBalance(rpc, payer.address, mint);
    const first = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "payment-signature": header }, body });
    expect(first.status).toBe(200);
    const replay = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "payment-signature": header }, body });
    expect(replay.status).toBe(402);
    expect(await tokenBalance(rpc, payer.address, mint)).toBe(before - USDC);
    expect(gw.odometer.deps.ledger.available(payer.address)).toBe(1_000_000 - 10);
  });

  it("serves an MCP agent through the stdio bridge, paying from its own wallet", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const { createKeyPairSignerFromPrivateKeyBytes, getBase58Encoder } = await import("@solana/kit");
    const { getTransferCheckedInstruction } = await import("@solana-program/token");
    const { sendInstructions, ata } = await import("./localnet.js");

    // An exportable wallet, as an agent operator would store it for the MCP server.
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const mcpWallet = await createKeyPairSignerFromPrivateKeyBytes(seed);
    const secret = [...seed, ...getBase58Encoder().encode(mcpWallet.address)];
    await createAta(rpc, agent, mcpWallet.address, mint);
    await sendInstructions(rpc, agent, [
      getTransferCheckedInstruction({
        source: await ata(agent.address, mint),
        mint,
        destination: await ata(mcpWallet.address, mint),
        authority: agent,
        amount: 2n * USDC,
        decimals: 6,
      }),
    ]);

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/mcp/main.ts"],
      env: {
        ...(process.env as Record<string, string>),
        ODOMETER_URL: gw.url,
        ODOMETER_WALLET_KEY: JSON.stringify(secret),
        ODOMETER_ALLOWED_ASSETS: mint,
        ODOMETER_MAX_TOPUP_USD: "1",
      },
      stderr: "pipe",
    });
    const mcp = new Client({ name: "e2e-agent", version: "1.0.0" });
    await mcp.connect(transport);
    try {
      const tools = (await mcp.listTools()).tools.map((t) => t.name).sort();
      expect(tools).toEqual(
        ["odometer_balance", "odometer_pricing", "odometer_topup", "solana_rpc_economy", "solana_rpc_fast", "solana_rpc_standard"].sort(),
      );
      const economy = (await mcp.listTools()).tools.find((t) => t.name === "solana_rpc_economy")!;
      expect(economy.description).toContain("ask your user how important speed is");

      const before = await tokenBalance(rpc, mcpWallet.address, mint);
      const call = await mcp.callTool({ name: "solana_rpc_economy", arguments: { method: "getBalance", params: [mcpWallet.address] } });
      expect(call.isError).toBeFalsy();
      const payload = JSON.parse((call.content as Array<{ text: string }>)[0]!.text);
      expect(payload.result.value).toBe(0);
      expect(payload.cost).toEqual({ chargedUsd: "0.00001", balanceUsd: "0.99999" });
      expect(payload.topup.payer).toBe(mcpWallet.address);
      expect(await tokenBalance(rpc, mcpWallet.address, mint)).toBe(before - USDC);

      const price = await mcp.callTool({ name: "odometer_pricing", arguments: { method: "getAsset" } });
      expect(JSON.parse((price.content as Array<{ text: string }>)[0]!.text).priceUsd.fast).toBe("0.0002");
      const bal = await mcp.callTool({ name: "odometer_balance", arguments: {} });
      expect(JSON.parse((bal.content as Array<{ text: string }>)[0]!.text).availableUsd).toBe("0.99999");

      // Spend limits are enforced in the agent's process: a $5 top-up exceeds the $1 cap.
      const refused = await mcp.callTool({ name: "odometer_topup", arguments: { usd: 5 } });
      expect(refused.isError).toBe(true);
      expect(JSON.parse((refused.content as Array<{ text: string }>)[0]!.text).error).toBe("topup_over_limit");
    } finally {
      await mcp.close();
    }
  });

  it("keeps the ledger reconciled with what moved on-chain", async () => {
    const topups = gw.odometer.deps.ledger.listTopups({ status: "settled" });
    const credited = topups.reduce((s, t) => s + Number(t.amount), 0);
    const received = await tokenBalance(rpc, operator.address, mint);
    expect(BigInt(credited)).toBe(received);
    expect(gw.odometer.deps.ledger.reconcile().ok).toBe(true);
    const bal = await client.balance();
    expect(bal.wallet).toBe(agent.address);
  });
});
