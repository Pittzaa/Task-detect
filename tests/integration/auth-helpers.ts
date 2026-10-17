import { createAuth, type Auth } from "@/server/auth";
import { createCaptureSender } from "@/integrations/email";
import { setRuntimeForTests } from "@/server/runtime";
import type { Db } from "@/db/client";

export const BASE = "http://localhost:3000";
export const PASSWORD = "correct-horse-battery-9";

export function makeAuthApp(db: Db, opts: { rateLimit?: boolean } = {}) {
  const email = createCaptureSender();
  const auth: Auth = createAuth({ db, baseURL: BASE, secret: "test-secret-test-secret-test-secret-00", email, rateLimit: opts.rateLimit ?? false });
  setRuntimeForTests({ db, auth, email, appUrl: BASE });
  return { auth, email };
}

/** Minimal browser-like client: keeps cookies and talks to handlers in-process. */
export class Client {
  cookies = new Map<string, string>();
  constructor(private auth: Auth, private origin = BASE) {}

  private cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  private store(res: Response) {
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(";");
      const [name, ...rest] = pair!.split("=");
      const value = rest.join("=");
      const expired = attrs.some((a) => /max-age=0/i.test(a.trim())) || value === "";
      if (expired) this.cookies.delete(name!.trim());
      else this.cookies.set(name!.trim(), value);
    }
  }

  request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    return new Request(path.startsWith("http") ? path : BASE + path, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(this.origin ? { origin: this.origin } : {}),
        ...(this.cookies.size ? { cookie: this.cookieHeader() } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  /** Better Auth endpoints (/api/auth/*). */
  async authCall(method: string, path: string, body?: unknown, headers?: Record<string, string>) {
    const res = await this.auth.handler(this.request(method, `/api/auth${path}`, body, headers));
    this.store(res);
    return res;
  }

  /** Our own route handlers, invoked directly with a Request. */
  async route(handler: (req: Request, ctx: never) => Promise<Response>, method: string, path: string, body?: unknown, params: Record<string, string> = {}) {
    const res = await handler(this.request(method, path, body), { params: Promise.resolve(params) } as never);
    this.store(res);
    return res;
  }
}

export function linkIn(text: string): string {
  const m = text.match(/https?:\/\/\S+/);
  if (!m) throw new Error("no link in email");
  return m[0].replace(/[).,]+$/, "");
}

/** Registers, verifies the email via the emailed link, and signs in. Returns the signed-in client. */
export async function registerAndSignIn(app: ReturnType<typeof makeAuthApp>, label: string, db?: Db) {
  const emailAddr = `${label}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const c = new Client(app.auth);
  const up = await c.authCall("POST", "/sign-up/email", { email: emailAddr, password: PASSWORD, name: label });
  if (up.status !== 200) throw new Error(`sign-up failed: ${up.status} ${await up.text()}`);
  const mail = [...app.email.sent].reverse().find((m) => m.to === emailAddr)!;
  await app.auth.handler(new Request(linkIn(mail.text)));
  const si = await c.authCall("POST", "/sign-in/email", { email: emailAddr, password: PASSWORD });
  if (si.status !== 200) throw new Error(`sign-in failed: ${si.status} ${await si.text()}`);
  void db;
  return { client: c, email: emailAddr };
}
