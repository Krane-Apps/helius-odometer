import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface MockReply {
  status?: number;
  headers?: Record<string, string>;
  /** JSON-RPC result (wrapped automatically) */
  result?: unknown;
  /** JSON-RPC error (wrapped automatically) */
  error?: { code: number; message: string; data?: unknown };
  /** Raw body, bypassing JSON-RPC wrapping */
  raw?: string;
  delayMs?: number;
}

export type MockHandler = (method: string, params: unknown, call: MockCall) => MockReply | Promise<MockReply>;

export interface MockCall {
  method: string;
  params: unknown;
  id: unknown;
  headers: IncomingMessage["headers"];
  url: string;
}

export interface MockRpc {
  url: string;
  calls: MockCall[];
  setHandler(h: MockHandler): void;
  callsFor(method: string): MockCall[];
  close(): Promise<void>;
}

/** A tiny JSON-RPC server for tests. Default handler answers getSlot with a fixed slot. */
export async function startMockRpc(handler?: MockHandler): Promise<MockRpc> {
  let current: MockHandler = handler ?? ((method) => (method === "getSlot" ? { result: 1000 } : { result: null }));
  const calls: MockCall[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      let body: { id?: unknown; method?: string; params?: unknown } = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        res.writeHead(400).end("bad json");
        return;
      }
      const call: MockCall = {
        method: String(body.method),
        params: body.params,
        id: body.id,
        headers: req.headers,
        url: req.url ?? "/",
      };
      calls.push(call);
      const reply = await current(call.method, call.params, call);
      if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
      if (res.destroyed) return;
      const text =
        reply.raw ??
        JSON.stringify(
          reply.error
            ? { jsonrpc: "2.0", id: body.id ?? null, error: reply.error }
            : { jsonrpc: "2.0", id: body.id ?? null, result: reply.result ?? null },
        );
      res.writeHead(reply.status ?? 200, { "content-type": "application/json", ...reply.headers });
      res.end(text);
    });
  });
  server.keepAliveTimeout = 1;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    setHandler: (h) => {
      current = h;
    },
    callsFor: (method) => calls.filter((c) => c.method === method),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
