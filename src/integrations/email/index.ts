import { appendFile } from "node:fs/promises";
import { parseAppName } from "@/domain/app-name";
import { logger } from "@/lib/logger";

export interface EmailMessage {
  to: string;
  subject: string;
  /** Plain-text twin of `html`, for clients and filters that cannot show HTML. */
  text: string;
  /** Every message is HTML (see templates.ts). */
  html: string;
  /** Sent as an Idempotency-Key so a retried job cannot deliver twice. */
  idempotencyKey?: string;
  /** The name to show as the sender (the product's name, src/domain/app-name.ts). The address stays the configured one; without it the configured display name is used. */
  fromName?: string;
}

export class EmailError extends Error {
  /** `status`: the provider's HTTP status when there was one. 400 and 422 refer to this message's address; 401 and 403 to our account with the provider. */
  constructor(message: string, readonly retryable: boolean, readonly status?: number) {
    super(message);
    this.name = "EmailError";
  }
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

/**
 * The `from` value for one message: the configured address (EMAIL_FROM, "name <address>" or just "address"), with `fromName` as the display name when
 * it is a valid product name (otherwise the configured display name, or none). Always a quoted string, so punctuation in a name cannot be misread.
 */
export function formatFrom(configured: string, fromName?: string): string {
  const m = /^(.*)<([^<>]+)>\s*$/.exec(configured.trim());
  const address = (m ? m[2]! : configured).trim();
  const configuredName = m ? m[1]!.trim().replace(/^"(.*)"$/, "$1").replace(/["\\\r\n]/g, "") : "";
  const parsed = fromName === undefined ? null : parseAppName(fromName);
  const name = parsed && parsed.ok && parsed.value ? parsed.value : configuredName;
  return name ? `"${name}" <${address}>` : address;
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
          body: JSON.stringify({ from: formatFrom(opts.from, m.fromName), to: [m.to], subject: m.subject, text: m.text, html: m.html }),
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        throw new EmailError("email provider unreachable", true);
      }
      if (!res.ok) {
        // Do not include the response body: it may echo recipient data.
        throw new EmailError(`email provider responded ${res.status}`, res.status === 429 || res.status >= 500, res.status);
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
      // every message must be HTML with a text twin: a caller that forgets is caught by whichever test sends it
      if (!/^<!doctype html>/i.test(m.html ?? "") || !m.text) throw new Error("e-mail without an HTML body and a text body");
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
      await appendFile(path, JSON.stringify({ to: m.to, from: m.fromName, subject: m.subject, text: m.text, html: m.html, at: new Date().toISOString() }) + "\n");
    },
  };
}
