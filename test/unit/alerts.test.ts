import { describe, expect, it } from "vitest";
import { Alerter } from "../../src/server/alerts.js";
import type { Logger } from "../../src/util/log.js";

function recordingLogger() {
  const lines: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> = [];
  const logger: Logger = {
    debug: (msg, fields) => lines.push({ level: "debug", msg, fields }),
    info: (msg, fields) => lines.push({ level: "info", msg, fields }),
    warn: (msg, fields) => lines.push({ level: "warn", msg, fields }),
    error: (msg, fields) => lines.push({ level: "error", msg, fields }),
    child: () => logger,
  };
  return { logger, lines };
}

function recordingFetch(respond: () => Response | Promise<Response> = () => new Response("ok")) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond();
  }) as typeof fetch;
  return { impl, calls };
}

describe("Alerter", () => {
  it("logs every alert and reports it was not delivered when no webhook is set", async () => {
    const { logger, lines } = recordingLogger();
    const { impl, calls } = recordingFetch();
    const alerter = new Alerter({ serviceName: "rpc-gw", dedupeMs: 60_000, logger, fetchImpl: impl });
    expect(alerter.configured).toBe(false);
    expect(await alerter.alert("k", "critical", "ledger mismatch", { n: 1 })).toBe(false);
    expect(calls).toHaveLength(0);
    expect(lines).toEqual([{ level: "error", msg: "ALERT ledger mismatch", fields: { alertKey: "k", severity: "critical", n: 1 } }]);
  });

  it("posts a Slack-compatible JSON body with the auth header", async () => {
    const { logger } = recordingLogger();
    const { impl, calls } = recordingFetch();
    const alerter = new Alerter({
      webhookUrl: "https://hooks.example/alert",
      authHeader: "Bearer hook-secret",
      serviceName: "rpc-gw",
      dedupeMs: 60_000,
      logger,
      fetchImpl: impl,
      now: () => Date.parse("2026-11-09T12:00:00Z"),
    });
    expect(await alerter.alert("settlement:abc", "warning", "top-up frozen", { amount: 5n })).toBe(true);
    expect(alerter.sent).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://hooks.example/alert");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers).toMatchObject({ "content-type": "application/json", authorization: "Bearer hook-secret" });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      service: "rpc-gw",
      severity: "warning",
      key: "settlement:abc",
      message: "top-up frozen",
      details: { amount: "5" },
      at: "2026-11-09T12:00:00.000Z",
      text: "[warning] rpc-gw: top-up frozen",
    });
  });

  it("suppresses repeats of the same key within the dedupe window", async () => {
    const { logger, lines } = recordingLogger();
    const { impl, calls } = recordingFetch();
    let now = 0;
    const alerter = new Alerter({ webhookUrl: "https://hooks.example/a", serviceName: "s", dedupeMs: 60_000, logger, fetchImpl: impl, now: () => now });
    expect(await alerter.alert("same", "critical", "m")).toBe(true);
    now = 30_000;
    expect(await alerter.alert("same", "critical", "m")).toBe(false);
    expect(await alerter.alert("other", "critical", "m")).toBe(true);
    now = 61_000;
    expect(await alerter.alert("same", "critical", "m")).toBe(true);
    expect(calls).toHaveLength(3);
    // Suppressed alerts still reach the log.
    expect(lines.filter((l) => l.msg === "ALERT m")).toHaveLength(4);
  });

  it("never throws when the webhook rejects or is unreachable", async () => {
    const { logger, lines } = recordingLogger();
    const rejecting = recordingFetch(() => new Response("nope", { status: 500 }));
    const a = new Alerter({ webhookUrl: "https://hooks.example/a", serviceName: "s", dedupeMs: 0, logger, fetchImpl: rejecting.impl });
    expect(await a.alert("k", "critical", "m")).toBe(false);
    expect(a.sent).toBe(0);
    const unreachable = recordingFetch(() => Promise.reject(new Error("ECONNREFUSED")));
    const b = new Alerter({ webhookUrl: "https://hooks.example/b", serviceName: "s", dedupeMs: 0, logger, fetchImpl: unreachable.impl });
    expect(await b.alert("k", "critical", "m")).toBe(false);
    expect(lines.map((l) => l.msg)).toEqual(expect.arrayContaining(["alert webhook rejected the alert", "alert webhook unreachable"]));
  });
});
