import { appendFile } from "node:fs/promises";
import { logger } from "@/lib/logger";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Sent as an Idempotency-Key so a retried job cannot deliver twice. */
  idempotencyKey?: string;
}

export class EmailError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = "EmailError";
  }
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

/**
 * Resend REST API. NOTE: not exercised against the real service in this repository's tests (no
 * credentials available); behaviour is verified only against a local stub server. See docs/TESTING.md.
 */
export function createResendSender(opts: { apiKey: string; from: string; endpoint?: string; fetchImpl?: typeof fetch }): EmailSender {
  const endpoint = opts.endpoint ?? "https://api.resend.com/emails";
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    async send(m) {
      let res: Response;
      try {
        res = await doFetch(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${opts.apiKey}`,
            "Content-Type": "application/json",
            ...(m.idempotencyKey ? { "Idempotency-Key": m.idempotencyKey } : {}),
          },
          body: JSON.stringify({ from: opts.from, to: [m.to], subject: m.subject, text: m.text, ...(m.html ? { html: m.html } : {}) }),
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        throw new EmailError("email provider unreachable", true);
      }
      if (!res.ok) {
        // Do not include the response body: it may echo recipient data.
        throw new EmailError(`email provider responded ${res.status}`, res.status === 429 || res.status >= 500);
      }
    },
  };
}

/** Development fallback when no provider is configured. Logs recipient and subject only. */
export function createLogSender(): EmailSender {
  return {
    async send(m) {
      logger.warn({ to: m.to, subject: m.subject }, "email not sent: no email provider configured");
    },
  };
}

/** Test double that records every message. */
export function createCaptureSender() {
  const sent: EmailMessage[] = [];
  const sender: EmailSender & { sent: EmailMessage[]; failNext?: EmailError } = {
    sent,
    async send(m) {
      if (sender.failNext) {
        const err = sender.failNext;
        sender.failNext = undefined;
        throw err;
      }
      sent.push(m);
    },
  };
  return sender;
}

/** Development/E2E sink: appends each message as a JSON line. Never used in production. */
export function createFileSender(path: string): EmailSender {
  return {
    async send(m) {
      await appendFile(path, JSON.stringify({ to: m.to, subject: m.subject, text: m.text, at: new Date().toISOString() }) + "\n");
    },
  };
}
