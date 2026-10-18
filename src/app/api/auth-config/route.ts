import { getRuntime } from "@/server/runtime";
import { registrationState } from "@/server/registration";

/** Public: which optional sign-in methods are configured and whether new people may register, so the pages can say so. Reveals no secrets. */
export async function GET() {
  const rt = getRuntime();
  try {
    const r = await registrationState(rt.db);
    return Response.json({ google: rt.googleSignIn, registrationOpen: r.open, singleOrganization: r.organizations === 1 });
  } catch {
    // the database being unreachable must not break the sign-in page; the sign-up attempt itself is checked again server-side
    return Response.json({ google: rt.googleSignIn, registrationOpen: true, singleOrganization: false });
  }
}
