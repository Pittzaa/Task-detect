-- Pre-membership flows need narrow, token/slug-keyed read access that the org_id policies cannot give.
-- Each extra policy is permissive (OR-ed with the tenant policy) and only matches a value the caller
-- must already know and set in the same transaction: app.org_slug or app.invite_token_hash.

DROP POLICY org_select ON organizations;
--> statement-breakpoint
-- A session sees (a) its current org, (b) orgs where the user has an APPROVED membership (org switcher),
-- (c) the single org whose slug the caller supplied (join-request flow).
CREATE POLICY org_select ON organizations FOR SELECT USING (
  id = app_org_id()
  OR slug = nullif(current_setting('app.org_slug', true), '')
  OR EXISTS (
    SELECT 1 FROM memberships m
    WHERE m.org_id = organizations.id AND m.user_id = app_user_id() AND m.status = 'approved'
  )
);
--> statement-breakpoint
-- Invitations can be read/updated by token hash before the accepting user has any membership.
CREATE POLICY invite_by_token_select ON invitations FOR SELECT
  USING (token_hash = nullif(current_setting('app.invite_token_hash', true), ''));
--> statement-breakpoint
CREATE POLICY invite_by_token_update ON invitations FOR UPDATE
  USING (token_hash = nullif(current_setting('app.invite_token_hash', true), ''))
  WITH CHECK (token_hash = nullif(current_setting('app.invite_token_hash', true), ''));
