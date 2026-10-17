import { jobHealth } from "@/data/integrations";
import { handle } from "@/server/api";

export const GET = (req: Request, { params }: { params: Promise<{ orgId: string }> }) => handle(req, async (c) => c.tenant((await params).orgId, (s) => jobHealth(s)));
