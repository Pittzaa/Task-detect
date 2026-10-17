export const dynamic = "force-dynamic";

/** Liveness: proves the function runs. Public, no data, no database access. */
export function GET() {
  return Response.json({ status: "ok" }, { headers: { "cache-control": "no-store" } });
}
