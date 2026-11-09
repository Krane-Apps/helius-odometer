import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMockRpc, type MockRpc } from "../helpers/mock-rpc.js";
import { FakeFacilitator } from "../helpers/fake-facilitator.js";
import { startApp, type StartedApp } from "../helpers/app-fixture.js";
import { SOLANA_DEVNET } from "../../src/config.js";

/**
 * Review finding 5 (2026-11-09): "failed calls are never charged" overstated
 * the contract. Every surface now states the same, accurate contract.
 */
describe("billing contract", () => {
  let pub: MockRpc;
  let gw: StartedApp;
  beforeAll(async () => {
    pub = await startMockRpc(() => ({ result: 1 }));
    gw = await startApp({ PUBLIC_UPSTREAMS: pub.url }, new FakeFacilitator(SOLANA_DEVNET));
  });
  afterAll(async () => {
    await gw.close();
    await pub.close();
  });

  it("lists billed error codes and separates sendTransaction acceptance and fees on /pricing", async () => {
    const pricing = (await (await fetch(`${gw.url}/pricing`)).json()) as { billing: Record<string, unknown> };
    expect(pricing.billing.billedErrorCodes).toEqual(expect.arrayContaining([-32602, -32002, -32003]));
    expect(String(pricing.billing.sendTransaction)).toMatch(/accepted the transaction.*not mean the transaction landed/);
    expect(String(pricing.billing.separateCosts)).toMatch(/priority fees and tips/);
  });

  it("never claims that every failed call is free", async () => {
    const llms = await (await fetch(`${gw.url}/llms.txt`)).text();
    expect(llms).not.toMatch(/never charged/);
    expect(llms).toMatch(/errors your request causes/);
    expect(llms).toMatch(/not that it landed/);
  });
});
