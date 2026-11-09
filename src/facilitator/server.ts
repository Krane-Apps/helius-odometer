import { Hono } from "hono";
import { x402Facilitator } from "@x402/core/facilitator";
import type { Network, PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { toFacilitatorSvmSigner } from "@x402/svm";
import { registerExactSvmScheme } from "@x402/svm/exact/facilitator";
import { createSolanaRpc, type KeyPairSigner } from "@solana/kit";
import type { Logger } from "../util/log.js";

export interface LocalFacilitatorOptions {
  /** Fee payer that co-signs and pays network fees for every settlement. */
  signer: KeyPairSigner;
  rpcUrl: string;
  networks: string[];
  /** Transaction message versions to accept. Use [0] for validators without v1 support. */
  transactionVersions?: ReadonlyArray<0 | 1>;
  logger: Logger;
}

/**
 * A self-hosted x402 facilitator for the Solana `exact` scheme, built only
 * from the official @x402 SDKs. Used for local development and end-to-end
 * tests, and an option for operators who want to settle top-ups themselves.
 */
export function createFacilitatorApp(opts: LocalFacilitatorOptions): { app: Hono; facilitator: x402Facilitator } {
  const rpc = createSolanaRpc(opts.rpcUrl);
  const rpcByNetwork = Object.fromEntries(opts.networks.map((n) => [n, rpc]));
  const svmSigner = toFacilitatorSvmSigner(opts.signer, rpcByNetwork as never);
  const facilitator = new x402Facilitator();
  registerExactSvmScheme(facilitator, {
    signer: svmSigner,
    networks: opts.networks as Network[],
    transactionVersions: opts.transactionVersions ?? [0],
  });
  facilitator.onAfterSettle(async (ctx) => {
    opts.logger.info("facilitator settled", {
      transaction: ctx.result.transaction,
      payer: ctx.result.payer,
      amount: ctx.requirements.amount,
      success: ctx.result.success,
    });
  });

  const app = new Hono();
  app.get("/supported", (c) => c.json(facilitator.getSupported()));
  const parse = async (body: unknown) => {
    const b = body as { paymentPayload?: PaymentPayload; paymentRequirements?: PaymentRequirements };
    if (!b?.paymentPayload || !b.paymentRequirements) throw new Error("paymentPayload and paymentRequirements are required");
    return { payload: b.paymentPayload, requirements: b.paymentRequirements };
  };
  app.post("/verify", async (c) => {
    try {
      const { payload, requirements } = await parse(await c.req.json());
      return c.json(await facilitator.verify(payload, requirements));
    } catch (err) {
      return c.json({ isValid: false, invalidReason: "invalid_request", invalidMessage: errMessage(err) }, 400);
    }
  });
  app.post("/settle", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
      const { payload, requirements } = await parse(body);
      return c.json(await facilitator.settle(payload, requirements));
    } catch (err) {
      const network = (body as { paymentRequirements?: { network?: string } })?.paymentRequirements?.network ?? "";
      opts.logger.warn("facilitator settle error", { error: errMessage(err) });
      return c.json({ success: false, errorReason: "unexpected_settle_error", errorMessage: errMessage(err), transaction: "", network }, 200);
    }
  });
  app.get("/health", (c) => c.json({ ok: true, feePayer: opts.signer.address, networks: opts.networks }));
  return { app, facilitator };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
