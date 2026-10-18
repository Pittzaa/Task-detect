import { exportMyData } from "@/data/privacy";
import { handle } from "@/server/api";

/** A download of everything held about the signed-in user (GDPR/PDPA access request). Heavy, so rate limited per user. */
export const GET = (req: Request) =>
  handle(
    req,
    async ({ db, user }) => {
      const data = await exportMyData(db, user.id);
      const stamp = data.generatedAt.slice(0, 10);
      return new Response(JSON.stringify(data, null, 2), {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": `attachment; filename="my-data-${stamp}.json"`,
          "cache-control": "no-store",
        },
      });
    },
    { limit: { name: "me-export", windowSeconds: 3600, max: 5 } },
  );
