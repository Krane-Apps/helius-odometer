import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface HeliusProxy {
  url: string;
  calls: string[];
  close(): Promise<void>;
}

/**
 * Stands in for Helius in end-to-end tests: standard Solana methods are
 * forwarded to the local validator (so transactions really land); DAS and
 * other Helius-only methods get canned answers. Every call is recorded.
 */
export async function startHeliusProxy(validatorUrl: string): Promise<HeliusProxy> {
  const calls: string[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let body: { id?: unknown; method?: string; params?: unknown };
      try {
        body = JSON.parse(text);
      } catch {
        res.writeHead(400).end();
        return;
      }
      const method = String(body.method);
      calls.push(method);
      const reply = (payload: unknown) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (method === "getAsset") {
        return reply({ jsonrpc: "2.0", id: body.id, result: { id: (body.params as { id?: string })?.id, interface: "V1_NFT", source: "helius-proxy" } });
      }
      if (method === "getPriorityFeeEstimate") {
        return reply({ jsonrpc: "2.0", id: body.id, result: { priorityFeeEstimate: 1000 } });
      }
      try {
        const upstream = await fetch(validatorUrl, { method: "POST", headers: { "content-type": "application/json" }, body: text });
        res.writeHead(upstream.status, { "content-type": "application/json" });
        res.end(await upstream.text());
      } catch (err) {
        res.writeHead(502).end(String(err));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
