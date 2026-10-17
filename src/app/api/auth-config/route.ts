import { getRuntime } from "@/server/runtime";

/** Public: which optional sign-in methods are configured, so the login page can show them. Reveals no secrets. */
export function GET() {
  const rt = getRuntime();
  return Response.json({ google: rt.googleSignIn });
}
