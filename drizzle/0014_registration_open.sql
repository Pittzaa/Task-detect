ALTER TABLE "organizations" ADD COLUMN "registration_open" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
CREATE POLICY "org_update" ON "organizations" FOR UPDATE USING (id = app_org_id()) WITH CHECK (id = app_org_id());
