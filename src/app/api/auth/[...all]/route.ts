import { toNextJsHandler } from "better-auth/next-js";
import { getRuntime } from "@/server/runtime";

// Better Auth owns sign-up/sign-in/session/2FA/reset routes and its own origin + rate-limit checks.
const h = () => toNextJsHandler(getRuntime().auth);
export const GET = (req: Request) => h().GET(req);
export const POST = (req: Request) => h().POST(req);
