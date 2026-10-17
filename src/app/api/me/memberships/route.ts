import { listMyMemberships } from "@/data/account";
import { handle } from "@/server/api";

export const GET = (req: Request) => handle(req, async ({ db, user }) => ({ memberships: await listMyMemberships(db, user.id) }));
