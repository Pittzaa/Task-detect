import pino from "pino";

/** Keys whose values must never reach logs. Matched at any depth one level under common containers. */
export const REDACT_PATHS = [
  "password",
  "token",
  "secret",
  "authorization",
  "cookie",
  "webhookUrl",
  "accessToken",
  "refreshToken",
  "*.password",
  "*.token",
  "*.secret",
  "*.authorization",
  "*.cookie",
  "*.webhookUrl",
  "*.accessToken",
  "*.refreshToken",
  "req.headers.authorization",
  "req.headers.cookie",
];

export function createLogger(level = process.env.LOG_LEVEL ?? "info", destination?: pino.DestinationStream) {
  return pino({ level, redact: { paths: REDACT_PATHS, censor: "[REDACTED]" } }, destination);
}

export const logger = createLogger();
