import { finishCalendarConnect } from "@/data/calendar";
import { logger } from "@/lib/logger";
import { getRuntime } from "@/server/runtime";

/** Google redirects the browser here (a top-level GET, so the session cookie is sent). */
export async function GET(req: Request) {
  const rt = getRuntime();
  const url = new URL(req.url);
  const back = (path: string) => Response.redirect(`${rt.appUrl}${path}`, 303);
  try {
    const session = await rt.auth.api.getSession({ headers: req.headers });
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!session || !code || !state || url.searchParams.get("error") || !rt.google || !rt.encryptionKeys.length) return back("/?calendar=error");
    const { orgId } = await finishCalendarConnect(rt.db, session.user.id, { code, state }, rt.google, { encryptionKeys: rt.encryptionKeys });
    return back(`/o/${orgId}/settings?calendar=connected`);
  } catch (e) {
    logger.warn({ err: e instanceof Error ? e.constructor.name : "unknown" }, "calendar connect failed");
    return back("/?calendar=error");
  }
}
