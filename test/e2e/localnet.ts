import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendTransactionMessageInstructions,
  createSolanaRpc,
  createTransactionMessage,
  devnet,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type Signature,
} from "@solana/kit";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";

/** Local validators expose devnet-style APIs (including requestAirdrop). */
export function localRpc(url: string) {
  return createSolanaRpc(devnet(url));
}
export type Rpc = ReturnType<typeof localRpc>;

export interface Validator {
  rpcUrl: string;
  mode: "native" | "docker";
  stop(): Promise<void>;
}

const DEFAULT_IMAGE = "anzaxyz/agave:v2.3.13";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

async function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

function findBinary(): string | undefined {
  const candidates = [process.env.SOLANA_TEST_VALIDATOR, "/opt/solana/bin/solana-test-validator"];
  const which = spawnSync("sh", ["-c", "command -v solana-test-validator"], { encoding: "utf8" });
  if (which.status === 0 && which.stdout.trim()) candidates.push(which.stdout.trim());
  return candidates.find((c): c is string => !!c && existsSync(c));
}

function dockerAvailable(): boolean {
  return spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8" }).status === 0;
}

/** True when a validator can be started here (native binary or Docker). */
export function validatorAvailable(): boolean {
  return !!findBinary() || dockerAvailable();
}

async function waitHealthy(rpcUrl: string, timeoutMs: number, proc?: ChildProcess): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (proc && proc.exitCode !== null) throw new Error(`validator exited with code ${proc.exitCode}`);
    try {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot", params: [{ commitment: "confirmed" }] }),
      });
      const body = (await res.json()) as { result?: number };
      if (typeof body.result === "number" && body.result >= 2) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`validator not healthy after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Starts solana-test-validator on free ports: native binary first, Docker as a fallback. */
export async function startValidator(): Promise<Validator> {
  let rpcPort = 0;
  for (let i = 0; i < 50; i++) {
    const p = await freePort();
    if (p < 65000 && (await portIsFree(p + 1))) {
      rpcPort = p;
      break;
    }
  }
  if (!rpcPort) throw new Error("no free port pair for the validator");
  const rpcUrl = `http://127.0.0.1:${rpcPort}`;
  const binary = findBinary();
  if (binary) {
    const ledger = mkdtempSync(join(tmpdir(), "odometer-ledger-"));
    const faucet = await freePort();
    const gossip = await freePort();
    const dynStart = 20_000 + Math.floor(Math.random() * 40_000);
    const proc = spawn(
      binary,
      [
        "--reset",
        "--quiet",
        "--ledger",
        ledger,
        "--bind-address",
        "127.0.0.1",
        "--rpc-port",
        String(rpcPort),
        "--faucet-port",
        String(faucet),
        "--gossip-port",
        String(gossip),
        "--dynamic-port-range",
        `${dynStart}-${dynStart + 60}`,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    proc.stderr?.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4000)));
    try {
      await waitHealthy(rpcUrl, 90_000, proc);
    } catch (err) {
      proc.kill("SIGKILL");
      throw new Error(`${(err as Error).message}\n${stderr}`);
    }
    return {
      rpcUrl,
      mode: "native",
      stop: async () => {
        proc.kill("SIGTERM");
        await new Promise((r) => setTimeout(r, 300));
        if (proc.exitCode === null) proc.kill("SIGKILL");
        rmSync(ledger, { recursive: true, force: true });
      },
    };
  }
  if (!dockerAvailable()) throw new Error("no solana-test-validator binary and no Docker daemon");
  const image = process.env.E2E_VALIDATOR_IMAGE ?? DEFAULT_IMAGE;
  const run = spawnSync(
    "docker",
    ["run", "-d", "--rm", "-p", `127.0.0.1:${rpcPort}:8899`, "-p", `127.0.0.1:${rpcPort + 1}:8900`, "--entrypoint", "solana-test-validator", image, "--reset", "--quiet"],
    { encoding: "utf8" },
  );
  if (run.status !== 0) throw new Error(`docker run failed: ${run.stderr}`);
  const id = run.stdout.trim();
  await waitHealthy(rpcUrl, 120_000);
  return {
    rpcUrl,
    mode: "docker",
    stop: async () => {
      spawnSync("docker", ["rm", "-f", id]);
    },
  };
}

export async function confirm(rpc: Rpc, signature: Signature, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    const status = value[0];
    if (status?.err) throw new Error(`transaction ${signature} failed: ${JSON.stringify(status.err, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
    if (status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) return;
    if (Date.now() > deadline) throw new Error(`transaction ${signature} not confirmed in time`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Builds, signs (with every signer referenced by the instructions) and confirms a transaction. */
export async function sendInstructions(rpc: Rpc, payer: KeyPairSigner, instructions: Instruction[]): Promise<Signature> {
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const signed = await signTransactionMessageWithSigners(message);
  const signature = await rpc
    .sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: "base64", preflightCommitment: "confirmed" })
    .send();
  await confirm(rpc, signature);
  return signature;
}

export async function airdrop(rpc: Rpc, to: Address, sol: number): Promise<void> {
  const signature = await rpc.requestAirdrop(to, lamports(BigInt(Math.round(sol * 1e9)))).send();
  await confirm(rpc, signature);
}

export async function createMint(rpc: Rpc, payer: KeyPairSigner, decimals: number): Promise<Address> {
  const mint = await generateKeyPairSigner();
  const space = BigInt(getMintSize());
  const rent = await rpc.getMinimumBalanceForRentExemption(space).send();
  await sendInstructions(rpc, payer, [
    getCreateAccountInstruction({ payer, newAccount: mint, lamports: rent, space, programAddress: TOKEN_PROGRAM_ADDRESS }),
    getInitializeMint2Instruction({ mint: mint.address, decimals, mintAuthority: payer.address }),
  ]);
  return mint.address;
}

export async function ata(owner: Address, mint: Address): Promise<Address> {
  const [address] = await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  return address;
}

export async function createAta(rpc: Rpc, payer: KeyPairSigner, owner: Address, mint: Address): Promise<Address> {
  await sendInstructions(rpc, payer, [await getCreateAssociatedTokenIdempotentInstructionAsync({ payer, owner, mint })]);
  return ata(owner, mint);
}

export async function mintTo(rpc: Rpc, authority: KeyPairSigner, mint: Address, owner: Address, amount: bigint): Promise<void> {
  const token = await createAta(rpc, authority, owner, mint);
  await sendInstructions(rpc, authority, [getMintToInstruction({ mint, token, mintAuthority: authority, amount })]);
}

export async function tokenBalance(rpc: Rpc, owner: Address, mint: Address): Promise<bigint> {
  try {
    const { value } = await rpc.getTokenAccountBalance(await ata(owner, mint)).send();
    return BigInt(value.amount);
  } catch {
    return 0n;
  }
}
