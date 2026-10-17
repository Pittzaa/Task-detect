/**
 * Content-Security-Policy for HTML pages. Scripts run only with the per-request nonce (Next.js applies it to its own
 * scripts), so an injected <script> or inline handler cannot execute even if some markup were ever to slip through.
 *
 * Inline style *attributes* are allowed (`style-src-attr`) because the UI sets sizes and colours with them; style
 * *elements* still need the nonce. Attributes cannot run script, so this is a deliberate, narrow concession.
 */
export function buildCsp(nonce: string, o: { dev?: boolean; upgrade?: boolean } = {}): string {
  const dev = !!o.dev;
  // Only meaningful (and only safe) when the site is served over HTTPS; browsers would break plain-http test servers.
  const upgrade = o.upgrade ?? !dev;
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data:", // data: for the two-factor QR code, which is generated in the browser
    "font-src 'self'",
    `connect-src 'self'${dev ? " ws:" : ""}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(upgrade ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

/** 128 bits of randomness, base64: unguessable and unique per request. */
export function newNonce(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
}
