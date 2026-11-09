import type { Logger } from "../util/log.js";

export type AlertSeverity = "warning" | "critical";

export interface AlerterOptions {
  /** POST target for alerts (Slack-compatible incoming webhooks, PagerDuty bridges, etc.). */
  webhookUrl?: string;
  /** Optional Authorization header value for the webhook. */
  authHeader?: string;
  serviceName: string;
  /** Repeat alerts with the same key are suppressed for this long. */
  dedupeMs: number;
  logger: Logger;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * Delivers operator alerts. Every alert is logged; when a webhook is set it
 * is also POSTed as JSON (with a `text` field so Slack-style webhooks render
 * it). Repeats of the same key are suppressed within the dedupe window.
 */
export class Alerter {
  private readonly last = new Map<string, number>();
  sent = 0;

  constructor(private readonly opts: AlerterOptions) {}

  get configured(): boolean {
    return !!this.opts.webhookUrl;
  }

  async alert(key: string, severity: AlertSeverity, message: string, details: Record<string, unknown> = {}): Promise<boolean> {
    const now = this.opts.now?.() ?? Date.now();
    const log = severity === "critical" ? this.opts.logger.error : this.opts.logger.warn;
    log(`ALERT ${message}`, { alertKey: key, severity, ...details });
    if (!this.opts.webhookUrl) return false;
    const previous = this.last.get(key);
    if (previous !== undefined && now - previous < this.opts.dedupeMs) return false;
    this.last.set(key, now);
    const body = {
      service: this.opts.serviceName,
      severity,
      key,
      message,
      details,
      at: new Date(now).toISOString(),
      text: `[${severity}] ${this.opts.serviceName}: ${message}`,
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await (this.opts.fetchImpl ?? fetch)(this.opts.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.opts.authHeader ? { authorization: this.opts.authHeader } : {}) },
        body: JSON.stringify(body, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)),
        signal: controller.signal,
      });
      await res.body?.cancel().catch(() => {});
      if (!res.ok) {
        this.opts.logger.warn("alert webhook rejected the alert", { status: res.status, alertKey: key });
        return false;
      }
      this.sent += 1;
      return true;
    } catch (err) {
      this.opts.logger.warn("alert webhook unreachable", { alertKey: key, error: err instanceof Error ? err.message : String(err) });
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
