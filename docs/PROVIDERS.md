# Providers, why each is used, plan assumptions and alternatives

**Pricing and plan limits below could not be read from the providers’ own pages** (the sandbox could not reach vercel.com or neon.com). Items from web-search snippets are marked *(unconfirmed)*. Check each against your plan before launch; the figures change.

| Provider | Role | Fixed by brief? | Plan assumptions | Alternative if it does not fit |
|---|---|---|---|---|
| **Vercel** | Hosting (Next.js), Cron | Yes | Cron every minute needs a paid plan *(unconfirmed: Hobby daily, Pro per-minute)*; function body limit ≈ 4.5 MB *(unconfirmed)*; function max duration must be ≥ 60 s for the tick. | External scheduler hitting `/api/cron/tick`; self-host Next.js. |
| **Neon** | PostgreSQL | Yes | Branching/point-in-time restore window depends on plan *(unconfirmed: short on free, up to 7–30 days on paid)*; connection limits via the pooler. | Any PostgreSQL ≥ 14 works (the schema uses `pg_trgm`, RLS, `SECURITY DEFINER`); local tests run on 16. |
| **Resend** | Transactional e-mail | Yes | Verified sending domain; daily/monthly sending limits per plan *(unconfirmed)*. | Any provider: implement `EmailSender` (`src/integrations/email/index.ts`, ~40 lines). |
| **Better Auth** (library, not a service) | Email+password, Google, TOTP, sessions | No (chosen) | Free, runs in our process and database. Chosen over Auth.js (MFA/org features to hand-roll) and Clerk (hosted SaaS: cost and lock-in). | Replace behind `src/server/auth.ts`; sessions table is under our control. |
| **Vercel Blob (private)** | Attachment bytes | No (chosen) | Private stores *(unconfirmed: generally available on all plans, SDK ≥ 2.3)*; pricing by storage/egress *(unknown)*. Code verified against `@vercel/blob` 2.8.2 types and source only. **Direct browser → Blob uploads** (4–25 MB) additionally depend on Blob accepting client tokens for a *private* store and on the API host `https://vercel.com/api/blob/` (taken from the SDK source) being the one the browser contacts. | S3-compatible storage (R2/S3): implement `ObjectStore` (`put/get/delete/list`, ~40 lines). |
| **Sentry or a compatible tracker** (optional) | Receives redacted server error events (`SENTRY_DSN`) | No | Hand-written envelope client (`src/lib/error-report.ts`), no SDK; works with Sentry and, by protocol, GlitchTip. Never reached from this repository's tests (a fake server only). | Leave `SENTRY_DSN` unset: errors go to the structured log only. |
| **Google Cloud** (optional) | OAuth for sign-in; Calendar API for one-way sync | No | Two OAuth clients; Calendar scope `calendar.events` is “sensitive”, so consent-screen verification may be required for external users *(unconfirmed)*. | Leave unconfigured — both features hide themselves. |
| **Discord** (optional) | Webhook notifications | No | Webhook rate limits apply per webhook *(unconfirmed)*; the app backs off and disables a failing destination. | Slack/Teams would be new handlers in `src/jobs/handlers/`. |
| **Postgres as the job queue** | Retries, leases, dead letters | No (chosen) | No extra service or cost; Vercel Cron only wakes it. | Inngest / Upstash QStash / Vercel Workflow — more features, another provider, limits unconfirmed. |
| **Playwright + Chromium, axe-core, vitest, pino, zod, Drizzle** | Tests, logging, validation, ORM | No | Open source dev/runtime libraries. | — |

No analytics, tracking pixels, third-party scripts, fonts, or CDNs are loaded by the pages (the CSP would block them).
