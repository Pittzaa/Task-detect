import type { Instrumentation } from "next";

/**
 * Next calls this for errors it catches itself: failed server renders, route handlers that throw outside `handle()`, server
 * actions. Errors inside `handle()` are already reported there. Only the path is kept (the query string and the headers can
 * carry user input and credentials) and the error goes through the same redaction as every other log line.
 */
export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return; // the reporter uses node:crypto; edge code (the proxy) has nothing to report
  const { reportError } = await import("@/lib/error-report");
  const digest = typeof err === "object" && err !== null && "digest" in err ? String((err as { digest: unknown }).digest) : undefined;
  let pending: Promise<unknown> | undefined;
  reportError(err, {
    kind: context.routeType === "render" ? "render" : context.routeType === "action" ? "action" : "api",
    method: request.method,
    path: request.path.split("?")[0],
    route: context.routePath,
    ...(digest ? { requestId: digest } : {}),
  }, (p) => { pending = p; });
  await pending; // the hook's lifetime is the request's: let the delivery finish
};
