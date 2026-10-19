#!/usr/bin/env node
// The "instant" e-mail mode on your own server: asks the app to do its background work every second (or POLL_INTERVAL_MS), so a notification
// e-mail leaves within about a second of the change instead of within the minute a cron allows.
//
// Plain Node, no dependencies. It does two things in a loop, one request at a time (never two at once, so a slow answer slows the loop instead
// of piling up requests):
//   * every POLL_INTERVAL_MS:  GET /api/cron/tick?fast=1   what people are waiting for: notifications, e-mails, reminders, recurring tasks
//   * every POLL_FULL_EVERY_MS: GET /api/cron/tick          the full pass: also digests, calendar reconcile, retention, orphan sweep
// Both need the CRON_SECRET the app was started with. It replaces the once-a-minute cron of README_VPS step 9; do not run both.
//
// Settings (environment): CRON_SECRET (required; or POLL_ENV_FILE, default /etc/task-tracker/env, a KEY=VALUE file that holds it),
// POLL_URL (default http://127.0.0.1:3000), POLL_INTERVAL_MS (default 1000, at least 250), POLL_FULL_EVERY_MS (default 60000).
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const DEFAULTS = { url: "http://127.0.0.1:3000", intervalMs: 1000, minIntervalMs: 250, fullEveryMs: 60_000, fastTimeoutMs: 20_000, fullTimeoutMs: 65_000, maxBackoffMs: 30_000 };

/** What to call next and how long to wait after it. Pure, so it can be tested without a server. */
export function nextStep({ now, lastFullAt, fullEveryMs, intervalMs, failures, maxBackoffMs = DEFAULTS.maxBackoffMs }) {
  const full = lastFullAt === null || now - lastFullAt >= fullEveryMs;
  // after errors wait longer (1 s, 2 s, 4 s ... up to maxBackoffMs) instead of hammering a server that is down or restarting
  const wait = failures > 0 ? Math.min(intervalMs * 2 ** Math.min(failures, 10), maxBackoffMs) : intervalMs;
  return { full, wait };
}

/**
 * Runs until `signal` is aborted (or `maxLoops` calls, for tests). `fetchImpl`, `sleep` and `clock` can be replaced in tests.
 * Returns the calls it made: [{ url, status }].
 */
export async function runPoller(o) {
  const base = String(o.url ?? DEFAULTS.url).replace(/\/+$/, "");
  const intervalMs = Math.max(DEFAULTS.minIntervalMs, Number(o.intervalMs ?? DEFAULTS.intervalMs) || DEFAULTS.intervalMs);
  const fullEveryMs = Math.max(intervalMs, Number(o.fullEveryMs ?? DEFAULTS.fullEveryMs) || DEFAULTS.fullEveryMs);
  const fetchImpl = o.fetchImpl ?? fetch;
  // the default sleep ends early when the poller is told to stop, so a service restart is not held up by a long back-off
  const sleep = o.sleep ?? ((ms) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    o.signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(undefined); }, { once: true });
  }));
  const clock = o.clock ?? Date.now;
  const log = o.log ?? ((m) => console.error(m));
  if (!o.secret) throw new Error("CRON_SECRET is required");
  const calls = [];
  let lastFullAt = null;
  let failures = 0;
  while (!o.signal?.aborted && (o.maxLoops === undefined || calls.length < o.maxLoops)) {
    const step = nextStep({ now: clock(), lastFullAt, fullEveryMs, intervalMs, failures });
    const url = `${base}/api/cron/tick${step.full ? "" : "?fast=1"}`;
    try {
      const res = await fetchImpl(url, { headers: { authorization: `Bearer ${o.secret}` }, signal: AbortSignal.timeout(step.full ? DEFAULTS.fullTimeoutMs : DEFAULTS.fastTimeoutMs) });
      calls.push({ url, status: res.status });
      await res.arrayBuffer().catch(() => undefined); // drain, so the connection can be reused
      if (res.ok) { failures = 0; if (step.full) lastFullAt = clock(); }
      else { failures++; log(`poller: ${url} answered ${res.status}${res.status === 401 ? " (CRON_SECRET does not match the app's)" : ""}`); }
    } catch (e) {
      calls.push({ url, status: 0 });
      failures++;
      log(`poller: ${url} failed: ${e instanceof Error ? e.message : "error"}`);
    }
    if (o.signal?.aborted) break;
    await sleep(nextStep({ now: clock(), lastFullAt, fullEveryMs, intervalMs, failures }).wait);
  }
  return calls;
}

function secretFromFile(path) {
  try {
    const line = readFileSync(path, "utf8").split("\n").find((l) => l.startsWith("CRON_SECRET="));
    return line ? line.slice("CRON_SECRET=".length).trim().replace(/^["']|["']$/g, "") : "";
  } catch { return ""; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const secret = process.env.CRON_SECRET || secretFromFile(process.env.POLL_ENV_FILE || "/etc/task-tracker/env");
  if (!secret) { console.error("poller: CRON_SECRET is not set (environment, or in POLL_ENV_FILE)"); process.exit(1); }
  const ac = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => ac.abort());
  console.error(`poller: ${process.env.POLL_URL || DEFAULTS.url}, every ${process.env.POLL_INTERVAL_MS || DEFAULTS.intervalMs} ms`);
  await runPoller({ url: process.env.POLL_URL, secret, intervalMs: process.env.POLL_INTERVAL_MS, fullEveryMs: process.env.POLL_FULL_EVERY_MS, signal: ac.signal });
}
