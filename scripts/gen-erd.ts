import { writeFileSync } from "node:fs";
import pg from "pg";

/**
 * Generates docs/generated/erd.md (a Mermaid ER diagram) from a migrated database, so the diagram is the real schema.
 *   tsx scripts/gen-erd.ts [postgres-url]    (default: the local e2e database)
 */
const url = process.argv[2] ?? "postgres://postgres@127.0.0.1:54329/tasktracker_e2e";

const GROUPS: Record<string, string[]> = {
  "Identity, tenancy and access": ["users", "organizations", "memberships", "invitations", "roles", "role_permissions", "role_assignments", "oauth_states"],
  "Authentication (Better Auth)": ["auth_sessions", "auth_accounts", "auth_verifications", "auth_two_factor", "auth_rate_limits", "app_rate_limits"],
  "Structure": ["departments", "teams", "projects", "project_teams"],
  "Work": ["tasks", "task_assignees", "task_dependencies", "labels", "task_labels", "comments", "comment_mentions", "task_activity", "attachments", "recurrence_series", "custom_field_defs", "custom_field_values", "saved_views"],
  "Notifications, jobs and integrations": ["notifications", "notification_settings", "notification_prefs", "delivery_attempts", "digest_log", "outbox_events", "jobs", "integration_destinations", "calendar_connections", "calendar_event_links"],
  "Audit": ["audit_logs"],
};

const ERD_INTRO = `# Entity-relationship diagram

The diagrams below are **generated from a migrated database** (\`pnpm docs:erd\`), so they show the real schema, not a design intent. Source of truth: \`src/db/schema.ts\` and \`drizzle/*.sql\`.

## Conventions

* **Tenancy:** every tenant table has \`org_id\`, and foreign keys between tenant tables are *composite* on (org_id, id) (the \`org_id\` half is omitted from the relationship lines), so a row can never reference another organization's row.
* **Row-level security:** every tenant table has RLS enabled and forced, keyed to the transaction-local \`app.org_id\` setting. Tables without RLS: \`users\` and the Better Auth tables (\`auth_*\`), plus the rate-limit counters.
* **Soft delete:** tasks, comments, attachments, saved views, recurrence series, integration destinations, projects, teams, departments, organizations and users carry \`deleted_at\`; purge rules are in [RETENTION.md](RETENTION.md).
* **Append-only:** \`audit_logs\` and \`task_activity\`.
* **Idempotency keys:** \`jobs.dedupe_key\`, \`notifications(user_id, dedupe_key)\`, \`tasks(series_id, occurrence_date)\` (live rows), \`calendar_event_links(connection_id, task_id)\`.
* **Scoped roles:** \`role_assignments\` has exactly one of \`department_id\`/\`team_id\`/\`project_id\` (or none for organization scope), each a composite foreign key.
* **Types:** Mermaid has no enum type; PostgreSQL enums (status, priority, job status, locale, …) appear under their type name.

## Where things are

| Area | Tables |
|---|---|
| Identity and tenancy | users, organizations, memberships, invitations, roles, role_permissions, role_assignments |
| Authentication | auth_sessions, auth_accounts, auth_verifications, auth_two_factor, auth_rate_limits, app_rate_limits, oauth_states |
| Structure | departments, teams, projects, project_teams |
| Work | tasks, task_assignees, task_dependencies, labels, task_labels, comments, comment_mentions, task_activity, attachments, recurrence_series, custom_field_defs, custom_field_values, saved_views |
| Notifications and integrations | notifications, notification_settings, notification_prefs, delivery_attempts, digest_log, outbox_events, jobs, integration_destinations, calendar_connections, calendar_event_links |
| Audit | audit_logs |
`;

const mermaidType = (t: string) => t.replace(/ /g, "_").replace(/[()]/g, "");

async function main() {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  const cols = (await c.query(`
    select c.table_name, c.column_name, c.data_type, c.udt_name, c.is_nullable
    from information_schema.columns c join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public' and t.table_type = 'BASE TABLE' order by c.table_name, c.ordinal_position`)).rows;
  const pks = new Set((await c.query(`
    select tc.table_name || '.' || kcu.column_name as k from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
    where tc.table_schema = 'public' and tc.constraint_type = 'PRIMARY KEY'`)).rows.map((r) => r.k as string));
  const fks = (await c.query(`
    select conrelid::regclass::text as child, confrelid::regclass::text as parent, conname,
      (select string_agg(a.attname, ',' order by u.ord) from unnest(conkey) with ordinality u(attnum, ord) join pg_attribute a on a.attrelid = conrelid and a.attnum = u.attnum) as cols,
      array_length(conkey, 1) as n
    from pg_constraint where contype = 'f' and connamespace = 'public'::regnamespace order by 1, 3`)).rows as { child: string; parent: string; conname: string; cols: string; n: number }[];
  const fkCols = new Set<string>();
  for (const f of fks) for (const col of f.cols.split(",")) if (col !== "org_id") fkCols.add(`${f.child}.${col}`);
  await c.end();

  const byTable = new Map<string, typeof cols>();
  for (const r of cols) (byTable.get(r.table_name) ?? byTable.set(r.table_name, []).get(r.table_name)!).push(r);

  const out: string[] = [
    "<!-- GENERATED by `pnpm docs:erd` from a migrated database. Do not edit by hand. -->",
    "",
    `${byTable.size} tables, ${fks.length} foreign keys. Composite keys \`(org_id, id)\` tie every tenant row to its organization; the \`org_id\` half is omitted from the relationship lines for readability.`,
    "",
  ];
  const seenPairs = new Set<string>();
  for (const [group, tables] of Object.entries(GROUPS)) {
    out.push(`### ${group}`, "", "```mermaid", "erDiagram");
    const inGroup = new Set(tables);
    for (const t of tables) {
      if (!byTable.has(t)) continue;
      out.push(`  ${t} {`);
      for (const col of byTable.get(t)!) {
        const key = pks.has(`${t}.${col.column_name}`) ? "PK" : fkCols.has(`${t}.${col.column_name}`) ? "FK" : "";
        out.push(`    ${mermaidType(col.data_type === "USER-DEFINED" ? col.udt_name : col.data_type)} ${col.column_name}${key ? ` ${key}` : ""}`);
      }
      out.push("  }");
    }
    for (const f of fks) {
      if (!inGroup.has(f.child) || !inGroup.has(f.parent) || f.child === f.parent) {
        if (f.child === f.parent && inGroup.has(f.child)) out.push(`  ${f.child} }o--o| ${f.parent} : "${f.cols.replace(/org_id,/, "")}"`);
        continue;
      }
      const key = `${f.child}>${f.parent}>${f.cols}`;
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      out.push(`  ${f.parent} ||--o{ ${f.child} : "${f.cols.replace(/org_id,/, "")}"`);
    }
    out.push("```", "");
    const external = new Set<string>();
    for (const f of fks) if (inGroup.has(f.child) && !inGroup.has(f.parent)) external.add(`${f.child} → ${f.parent}`);
    if (external.size) out.push(`Cross-group references: ${[...external].map((e) => `\`${e}\``).join(", ")}.`, "");
  }
  const diagram = out.join("\n");
  writeFileSync("docs/generated/erd.md", diagram);
  writeFileSync("docs/ERD.md", `${ERD_INTRO}\n${diagram}\n`);
  console.log(`wrote docs/generated/erd.md and docs/ERD.md (${byTable.size} tables, ${fks.length} foreign keys)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
