import { toNextJsHandler } from "better-auth/next-js";
import { NUL_MESSAGE } from "@/server/api";
import { guardAccount } from "@/server/auth-throttle";
import { getRuntime } from "@/server/runtime";

// Better Auth owns sign-up/sign-in/session/2FA/reset routes and its own origin + rate-limit checks.
const h = () => toNextJsHandler(getRuntime().auth);

/** The NUL character cannot be stored by PostgreSQL and would surface as a 500; refuse it up front (Better Auth's error shape). */
async function rejectNul(req: Request): Promise<Response | null> {
  const body = req.method === "GET" || req.method === "HEAD" ? "" : await req.clone().text().catch(() => "");
  if (/%00/i.test(req.url) || /\\u0000/i.test(body) || body.includes("\u0000")) {
    return Response.json({ message: NUL_MESSAGE, code: "INVALID_INPUT" }, { status: 422, headers: { "cache-control": "no-store" } });
  }
  return null;
}

export const GET = async (req: Request) => (await rejectNul(req)) ?? h().GET(req);
export const POST = async (req: Request) => (await rejectNul(req)) ?? guardAccount(req, getRuntime().db, () => h().POST(req));
