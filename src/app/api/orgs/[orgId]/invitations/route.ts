import { z } from "zod";
import { createInvitation, inviteAddressKey, listInvitations } from "@/data/account";
import { refundRateLimit } from "@/server/rate-limit";
import { renderEmail } from "@/integrations/email/templates";
import { t, type Locale } from "@/i18n";
import { handle, readJson } from "@/server/api";

export const GET = (req: Request, { params }: { params: Promise<{ orgId: string }> }) =>
  handle(req, async (c) => ({ invitations: await c.tenant((await params).orgId, (s) => listInvitations(s)) }));

export const POST = (req: Request, { params }: { params: Promise<{ orgId: string }> }) =>
  handle(
    req,
    async (c) => {
      const { orgId } = await params;
      const body = await readJson(req, z.object({ email: z.string().email().max(254), roleId: z.string().uuid(), locale: z.enum(["th", "en"]).optional() }).strict());
      const { inv, orgName } = await c.tenant(orgId, async (s) => {
        const inv = await createInvitation(s, { email: body.email, roleId: body.roleId });
        return { inv, orgName: (await s.tx.query.organizations.findFirst({ where: (o, { eq }) => eq(o.id, s.orgId) }))?.name ?? "" };
      });
      // Sent after commit. If delivery fails the invitation still exists and can be re-issued.
      const locale: Locale = body.locale ?? "th";
      const url = `${c.rt.appUrl}/invite?token=${encodeURIComponent(inv.token)}`;
      let emailed = true;
      try {
        const app = t(locale, "app.name");
        const { html, text } = renderEmail({
          locale,
          heading: t(locale, "email.invite.heading", { org: orgName }),
          intro: [t(locale, "email.invite.intro", { inviter: c.user.name, org: orgName, app })],
          button: { label: t(locale, "email.invite.button"), url },
        });
        await c.rt.email.send({ to: inv.email, subject: t(locale, "email.invite.subject", { org: orgName, app }), text, html });
      } catch {
        emailed = false;
        // nothing reached the address, so its allowance is not spent: the invitation can be re-issued at once
        await refundRateLimit(c.rt.db, inviteAddressKey(orgId, inv.email)).catch(() => undefined);
      }
      return { id: inv.id, email: inv.email, expiresAt: inv.expiresAt, emailed };
    },
    { status: 201 },
  );
