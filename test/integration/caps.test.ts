import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMockRpc, type MockRpc } from "../helpers/mock-rpc.js";
import { FakeFacilitator } from "../helpers/fake-facilitator.js";
import { startApp, type StartedApp } from "../helpers/app-fixture.js";
import { SOLANA_DEVNET } from "../../src/config.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (r: Response | Promise<Response>): Promise<any> => (await r).json();

describe("POST /v1/account/cap", () => {
  let pub: MockRpc;
  let gw: StartedApp;
  const wallet = "CapApi1111111111111111111111111111111111111";
  let auth: Record<string, string>;

  beforeAll(async () => {
    pub = await startMockRpc(() => ({ result: 1 }));
    gw = await startApp({ PUBLIC_UPSTREAMS: pub.url, WALLET_DAILY_CAP_USD: "1", WALLET_RPS: "1000" }, new FakeFacilitator(SOLANA_DEVNET));
    gw.odometer.deps.ledger.adjust(wallet, 5_000_000, "test funding");
    auth = { authorization: `Bearer ${gw.odometer.deps.sessions.issue(wallet).token}`, "content-type": "application/json" };
  });
  afterAll(async () => {
    await gw.close();
    await pub.close();
  });

  const setCap = (body: unknown) => fetch(`${gw.url}/v1/account/cap`, { method: "POST", headers: auth, body: JSON.stringify(body) });
  const call = () =>
    fetch(`${gw.url}/v1/rpc/economy`, { method: "POST", headers: auth, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot" }) });

  it("zero stops spending without erasing the operator ceiling", async () => {
    const stopped = await json(setCap({ dailyCapUsd: 0 }));
    expect(stopped).toMatchObject({ dailyCapUsd: "0", walletCapUsd: "0", operatorCapUsd: "1", spendingStopped: true });
    const refused = await call();
    expect(refused.status).toBe(429);
    expect((await json(refused)).error).toBe("daily_cap_exceeded");
  });

  it("null removes the wallet cap and the operator ceiling applies again", async () => {
    const view = await json(setCap({ dailyCapUsd: null }));
    expect(view).toMatchObject({ dailyCapUsd: "1", walletCapUsd: null, operatorCapUsd: "1", spendingStopped: false });
    expect((await call()).status).toBe(200);
  });

  it("a wallet cap above the operator ceiling cannot raise it", async () => {
    const view = await json(setCap({ dailyCapUsd: 1000 }));
    expect(view).toMatchObject({ dailyCapUsd: "1", walletCapUsd: "1000", operatorCapUsd: "1" });
  });

  it("rejects missing and negative caps", async () => {
    expect((await setCap({})).status).toBe(400);
    expect((await setCap({ dailyCapUsd: -1 })).status).toBe(400);
  });
});
