import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import type pg from "pg";

/**
 * Per-organization export and import (partial restore).
 *
 * The bundle holds every row of ONE organization plus the user profiles those rows refer to, without credentials. It is read and
 * written through an operator connection that can bypass row-level security (superuser or BYPASSRLS), the same requirement as
 * `pg_dump` for this schema; the application's runtime role is refused.
 *
 * Tables are discovered from the live schema (every table with an `org_id` column), ordered by their foreign keys, so a new table
 * is picked up without code changes. Transient operational tables are left out on purpose (jobs, outbox, delivery attempts,
 * digest log, OAuth states): after an import, give the background jobs a minute and ask users to reconnect nothing — calendar
 * sync is re-queued by the daily reconcile job.
 */
export const BUNDLE_FORMAT = "task-tracker-org-export";
export const BUNDLE_VERSION = 1;
/** Tables with an org_id that are NOT part of a bundle. */
export const TRANSIENT_TABLES = ["jobs", "outbox_events", "delivery_attempts", "digest_log", "oauth_states"] as const;
/** The only user columns that travel. Credentials, sessions, two-factor secrets and the platform-admin flag never do. */
const USER_COLUMNS = ["id", "email", "name", "email_verified", "image", "locale", "timezone", "created_at", "updated_at", "deleted_at"] as const;
const CHUNK = 500;

type Q = Pick<pg.Client, "query">;
type Row = Record<string, unknown>;

export interface OrgBundle {
  format: typeof BUNDLE_FORMAT;
  version: number;
  exportedAt: string;
  /** Fingerprint of the applied migrations: a bundle only loads into a database with exactly the same schema. */
  schema: { migrations: number; fingerprint: string };
  org: { id: string; slug: string; name: string };
  /** In dependency order. */
  tableOrder: string[];
  tables: Record<string, Row[]>;
  users: Row[];
  /** System roles are seeded per database with their own ids; rows refer to them by id, so the key travels with the id. */
  systemRoles: { id: string; key: string }[];
  counts: Record<string, number>;
  checksum: string;
}

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function bundleChecksum(b: Pick<OrgBundle, "org" | "tableOrder" | "tables" | "users" | "systemRoles" | "schema">): string {
  return sha256(JSON.stringify({ org: b.org, schema: b.schema, tableOrder: b.tableOrder, tables: b.tables, users: b.users, systemRoles: b.systemRoles }));
}

// ---------------------------------------------------------------------------------------------
// Schema discovery
// ---------------------------------------------------------------------------------------------

export interface Fk { child: string; parent: string; childCols: string[]; parentCols: string[] }
interface Plan {
  order: string[];
  predicate: Record<string, string>;
  columns: Record<string, string[]>;
  fks: Fk[];
  userFkCols: { table: string; column: string }[];
  roleFkCols: { table: string; column: string }[];
}

export async function assertOperator(q: Q): Promise<void> {
  const r = await q.query<{ rolsuper: boolean; rolbypassrls: boolean; rolname: string }>("select rolname, rolsuper, rolbypassrls from pg_roles where rolname = current_user");
  const me = r.rows[0];
  if (!me || !(me.rolsuper || me.rolbypassrls)) {
    throw new Error(`role "${me?.rolname}" can neither bypass row-level security nor is a superuser: organization export/import needs an operator role (the same one used for pg_dump). Refusing.`);
  }
}

async function discover(q: Q): Promise<Plan> {
  // From the catalog, not information_schema: that view hides tables the role has no privilege on, which would drop them from the
  // bundle without a word. With the catalog they are found, and reading one the role cannot read fails loudly.
  const withOrg = await q.query<{ table_name: string }>(
    `select c.relname as table_name from pg_attribute a join pg_class c on c.oid = a.attrelid
      where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and a.attname = 'org_id' and a.attnum > 0 and not a.attisdropped order by 1`,
  );
  const names = withOrg.rows.map((r) => r.table_name).filter((n) => !(TRANSIENT_TABLES as readonly string[]).includes(n));
  const selected = ["organizations", ...names, "role_permissions"];

  const fkRows = await q.query<{ child: string; parent: string; child_cols: string[]; parent_cols: string[] }>(
    `select cl.relname as child, pl.relname as parent,
        (select array_agg(a.attname::text order by k.ord) from unnest(c.conkey) with ordinality k(attnum, ord) join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) as child_cols,
        (select array_agg(a.attname::text order by k.ord) from unnest(c.confkey) with ordinality k(attnum, ord) join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.attnum) as parent_cols
       from pg_constraint c join pg_class cl on cl.oid = c.conrelid join pg_class pl on pl.oid = c.confrelid
      where c.contype = 'f' and cl.relnamespace = 'public'::regnamespace`,
  );
  const fks: Fk[] = fkRows.rows.map((r) => ({ child: r.child, parent: r.parent, childCols: r.child_cols, parentCols: r.parent_cols }));

  // Kahn's algorithm over the selected tables (self references are handled row by row, other tables are outside the bundle).
  const inSet = new Set(selected);
  const deps = new Map<string, Set<string>>(selected.map((t) => [t, new Set()]));
  for (const f of fks) if (inSet.has(f.child) && inSet.has(f.parent) && f.child !== f.parent) deps.get(f.child)!.add(f.parent);
  const order: string[] = [];
  const ready = selected.filter((t) => deps.get(t)!.size === 0).sort();
  while (ready.length) {
    const t = ready.shift()!;
    order.push(t);
    for (const [other, d] of deps) if (d.delete(t) && d.size === 0 && !order.includes(other) && !ready.includes(other)) ready.push(other);
    ready.sort();
  }
  if (order.length !== selected.length) throw new Error(`foreign keys between ${selected.filter((t) => !order.includes(t)).join(", ")} form a cycle: the exporter cannot order them`);

  // Every table must be reachable only through org_id (or the two special cases), otherwise its rows could leak between tenants.
  const predicate: Record<string, string> = { organizations: "id = $1", role_permissions: "role_id in (select id from roles where org_id = $1)" };
  for (const n of names) predicate[n] = "org_id = $1";

  const columns: Record<string, string[]> = {};
  for (const t of selected) {
    const cols = await q.query<{ attname: string }>(
      `select a.attname from pg_attribute a where a.attrelid = ($1)::regclass and a.attnum > 0 and not a.attisdropped and a.attgenerated = '' order by a.attnum`,
      [`public.${ident(t)}`],
    );
    columns[t] = cols.rows.map((r) => r.attname);
  }
  const roleFkCols = fks.filter((f) => f.parent === "roles" && inSet.has(f.child) && f.child !== "roles").map((f) => ({ table: f.child, column: f.childCols[0]! }));
  const userFkCols = fks.filter((f) => f.parent === "users" && inSet.has(f.child)).map((f) => ({ table: f.child, column: f.childCols[0]! }));
  return { order, predicate, columns, fks, userFkCols, roleFkCols };
}

async function schemaFingerprint(q: Q): Promise<{ migrations: number; fingerprint: string }> {
  const r = await q.query<{ hash: string }>("select hash from drizzle.__drizzle_migrations order by id");
  return { migrations: r.rows.length, fingerprint: sha256(r.rows.map((x) => x.hash).join("|")) };
}

/** Parents before children within one table (for example a subtask after its parent task). */
export function orderSelfReferences(rows: Row[], fk: Fk | undefined): Row[] {
  if (!fk || rows.length < 2) return rows;
  const key = (r: Row, cols: string[]) => cols.map((c) => String(r[c])).join("|");
  const byKey = new Map(rows.map((r) => [key(r, fk.parentCols), r]));
  const out: Row[] = [];
  const done = new Set<Row>();
  const visit = (r: Row, depth: number) => {
    if (done.has(r)) return;
    if (depth > rows.length) throw new Error("self-referencing rows form a cycle");
    if (fk.childCols.every((c) => r[c] !== null && r[c] !== undefined)) {
      const parent = byKey.get(key(r, fk.childCols));
      if (parent && parent !== r) visit(parent, depth + 1);
    }
    done.add(r); out.push(r);
  };
  for (const r of rows) visit(r, 0);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------------

export async function exportOrganization(q: Q, ref: string, now = new Date()): Promise<OrgBundle> {
  await assertOperator(q);
  await q.query("begin isolation level repeatable read read only");
  try {
    const found = await q.query<{ id: string; slug: string; name: string }>(
      "select id, slug, name from organizations where id::text = $1 or slug = $1 order by (id::text = $1) desc limit 1", [ref],
    );
    const org = found.rows[0];
    if (!org) throw new Error(`no organization with id or code "${ref}"`);
    const plan = await discover(q);

    const tables: Record<string, Row[]> = {};
    for (const t of plan.order) {
      const cols = plan.columns[t]!.map(ident).join(", ");
      const res = await q.query<{ rows: Row[] }>(`select coalesce(json_agg(x), '[]'::json) as rows from (select ${cols} from ${ident(t)} where ${plan.predicate[t]}) x`, [org.id]);
      const self = plan.fks.find((f) => f.child === t && f.parent === t);
      tables[t] = orderSelfReferences(res.rows[0]!.rows, self);
    }

    const userIds = new Set<string>();
    for (const { table, column } of plan.userFkCols) for (const r of tables[table]!) if (typeof r[column] === "string") userIds.add(r[column] as string);
    for (const r of tables.memberships ?? []) if (typeof r.user_id === "string") userIds.add(r.user_id);
    const users = userIds.size
      ? (await q.query<{ rows: Row[] }>(`select coalesce(json_agg(x order by x.id), '[]'::json) as rows from (select ${USER_COLUMNS.map(ident).join(", ")} from users where id = any($1::uuid[])) x`, [[...userIds]])).rows[0]!.rows
      : [];
    const systemRoles = (await q.query<{ id: string; key: string }>("select id, key from roles where org_id is null order by key")).rows;
    const schema = await schemaFingerprint(q);

    const base = { org, schema, tableOrder: plan.order, tables, users, systemRoles };
    return {
      format: BUNDLE_FORMAT, version: BUNDLE_VERSION, exportedAt: now.toISOString(), ...base,
      counts: Object.fromEntries([...plan.order.map((t) => [t, tables[t]!.length] as const), ["users", users.length] as const]),
      checksum: bundleChecksum(base),
    };
  } finally {
    await q.query("rollback");
  }
}

// ---------------------------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------------------------

export interface ImportPlan {
  org: { id: string; slug: string; name: string };
  exists: boolean;
  /** Rows currently in the target for this organization (what `replace` would delete). */
  existingRows: Record<string, number>;
  /** Rows the bundle would insert. */
  incomingRows: Record<string, number>;
  usersToCreate: number;
  usersAlreadyPresent: number;
  applied: boolean;
}

export function validateBundle(raw: unknown): OrgBundle {
  const b = raw as OrgBundle;
  if (!b || typeof b !== "object" || b.format !== BUNDLE_FORMAT) throw new Error("not an organization export from this application");
  if (b.version !== BUNDLE_VERSION) throw new Error(`unsupported bundle version ${String(b.version)} (this build reads version ${BUNDLE_VERSION})`);
  if (!b.org?.id || !b.tables || !Array.isArray(b.tableOrder) || !Array.isArray(b.users) || !Array.isArray(b.systemRoles)) throw new Error("the bundle is incomplete");
  if (bundleChecksum(b) !== b.checksum) throw new Error("checksum mismatch: the bundle was modified or damaged after it was written");
  return b;
}

/** The checksum detects damage, not forgery: whoever builds a bundle by hand can recompute it. Every row must belong to the bundle's own organization. */
export function assertOwnRows(plan: Pick<Plan, "order">, b: OrgBundle): void {
  const ownRoles = new Set((b.tables.roles ?? []).map((r) => r.id));
  for (const t of plan.order) {
    (b.tables[t] ?? []).forEach((r, i) => {
      const own = t === "organizations" ? r.id === b.org.id : t === "role_permissions" ? ownRoles.has(r.role_id) : r.org_id === b.org.id;
      if (!own) throw new Error(`row ${i + 1} of ${t} belongs to another organization; refusing (nothing was changed)`);
    });
  }
}

export async function importOrganization(q: Q, bundle: OrgBundle, o: { replace?: boolean; apply?: boolean } = {}): Promise<ImportPlan> {
  const b = validateBundle(bundle);
  await assertOperator(q);
  await q.query("begin");
  try {
    await q.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`orgimport:${b.org.id}`]);
    const plan = await discover(q);
    const here = await schemaFingerprint(q);
    if (here.fingerprint !== b.schema.fingerprint || here.migrations !== b.schema.migrations) {
      throw new Error(`schema mismatch: the bundle was written by a database with ${b.schema.migrations} migrations (${b.schema.fingerprint.slice(0, 12)}), this one has ${here.migrations} (${here.fingerprint.slice(0, 12)}). Run the same application version on both sides.`);
    }
    if (plan.order.join(",") !== b.tableOrder.join(",")) throw new Error("table layout differs from the bundle even though the migrations match; refusing");
    assertOwnRows(plan, b);

    const clash = await q.query<{ id: string }>("select id from organizations where slug = $1 and id <> $2", [b.org.slug, b.org.id]);
    if (clash.rows.length) throw new Error(`another organization already uses the code "${b.org.slug}"; refusing`);
    const existing = await q.query<{ id: string }>("select id from organizations where id = $1", [b.org.id]);
    const exists = existing.rows.length > 0;
    if (exists && !o.replace) throw new Error(`organization "${b.org.slug}" already exists in this database. Use --replace to overwrite it with the bundle (everything newer than the bundle is lost).`);

    const existingRows: Record<string, number> = {};
    if (exists) for (const t of plan.order) existingRows[t] = Number((await q.query<{ n: string }>(`select count(*) as n from ${ident(t)} where ${plan.predicate[t]}`, [b.org.id])).rows[0]!.n);

    // Users: keep whoever is already here (credentials stay), create the rest without credentials, refuse e-mail collisions.
    const ids = b.users.map((u) => u.id as string);
    const present = new Set((await q.query<{ id: string }>("select id from users where id = any($1::uuid[])", [ids])).rows.map((r) => r.id));
    const missing = b.users.filter((u) => !present.has(u.id as string));
    if (missing.length) {
      const collide = await q.query<{ email: string }>("select email from users where lower(email) = any($1::text[]) and id <> all($2::uuid[])", [missing.map((u) => String(u.email).toLowerCase()), ids]);
      if (collide.rows.length) throw new Error(`these e-mail addresses already belong to different accounts in this database: ${collide.rows.map((r) => r.email).join(", ")}. Resolve them first (nothing was changed).`);
    }

    // System roles are matched by key.
    const targetRoles = new Map((await q.query<{ id: string; key: string }>("select id, key from roles where org_id is null")).rows.map((r) => [r.key, r.id]));
    const roleMap = new Map<string, string>();
    for (const r of b.systemRoles) {
      const target = targetRoles.get(r.key);
      if (!target) throw new Error(`system role "${r.key}" does not exist in this database (run the application's role sync first)`);
      roleMap.set(r.id, target);
    }

    const result: ImportPlan = {
      org: b.org, exists, existingRows, incomingRows: Object.fromEntries(b.tableOrder.map((t) => [t, b.tables[t]?.length ?? 0])),
      usersToCreate: missing.length, usersAlreadyPresent: present.size, applied: false,
    };
    if (!o.apply) { await q.query("rollback"); return result; }

    if (exists) {
      for (const t of TRANSIENT_TABLES) await q.query(`delete from ${ident(t)} where org_id = $1`, [b.org.id]);
      for (const t of [...plan.order].reverse()) await q.query(`delete from ${ident(t)} where ${plan.predicate[t]}`, [b.org.id]);
    }
    if (missing.length) {
      const cols = USER_COLUMNS.map(ident).join(", ");
      for (let i = 0; i < missing.length; i += CHUNK) {
        await q.query(`insert into users (${cols}) select ${cols} from json_populate_recordset(null::users, $1::json)`, [JSON.stringify(missing.slice(i, i + CHUNK))]);
      }
    }
    for (const t of plan.order) {
      const roleCols = plan.roleFkCols.filter((c) => c.table === t).map((c) => c.column);
      const rows = (b.tables[t] ?? []).map((r) => {
        if (!roleCols.length) return r;
        const copy = { ...r };
        for (const c of roleCols) if (typeof copy[c] === "string" && roleMap.has(copy[c] as string)) copy[c] = roleMap.get(copy[c] as string);
        return copy;
      });
      const cols = plan.columns[t]!.map(ident).join(", ");
      for (let i = 0; i < rows.length; i += CHUNK) {
        await q.query(`insert into ${ident(t)} (${cols}) select ${cols} from json_populate_recordset(null::${ident(t)}, $1::json)`, [JSON.stringify(rows.slice(i, i + CHUNK))]);
      }
    }
    for (const t of plan.order) {
      const n = Number((await q.query<{ n: string }>(`select count(*) as n from ${ident(t)} where ${plan.predicate[t]}`, [b.org.id])).rows[0]!.n);
      if (n !== (b.tables[t]?.length ?? 0)) throw new Error(`verification failed for ${t}: expected ${b.tables[t]?.length ?? 0} rows, found ${n}; rolled back`);
    }
    await q.query("commit");
    return { ...result, applied: true };
  } catch (e) {
    await q.query("rollback").catch(() => undefined);
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------
// File format: gzip, optionally sealed with a passphrase (AES-256-GCM, scrypt-derived key)
// ---------------------------------------------------------------------------------------------

/** TTORG1 files used scrypt's defaults (N=2^14); TTORG2 uses N=2^17, r=8, p=1 (the OWASP minimum). Both are still readable. */
const MAGIC_V1 = Buffer.from("TTORG1\n");
const MAGIC_V2 = Buffer.from("TTORG2\n");
const SCRYPT_V2 = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const MAX_BUNDLE_BYTES = 1024 * 1024 * 1024;

export function sealBundle(bundle: OrgBundle, passphrase?: string): Buffer {
  const packed = gzipSync(Buffer.from(JSON.stringify(bundle), "utf8"));
  if (!passphrase) return packed;
  if (passphrase.length < 12) throw new Error("the passphrase must be at least 12 characters");
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", scryptSync(passphrase, salt, 32, SCRYPT_V2), iv);
  const body = Buffer.concat([cipher.update(packed), cipher.final()]);
  return Buffer.concat([MAGIC_V2, salt, iv, cipher.getAuthTag(), body]);
}

export interface OpenOptions {
  /** Accept a file that is not encrypted although a passphrase is set. Off by default: an unencrypted file carries no proof of who wrote it. */
  allowUnsealed?: boolean;
  /** Largest size the file may unpack to (default 1 GiB), against a compressed file crafted to exhaust memory. */
  maxBytes?: number;
}

export function openBundle(file: Buffer, passphrase?: string, opts: OpenOptions = {}): OrgBundle {
  let packed = file;
  const magic = [MAGIC_V2, MAGIC_V1].find((m) => file.subarray(0, m.length).equals(m));
  if (magic) {
    if (!passphrase) throw new Error("this file is encrypted: set ORG_EXPORT_PASSPHRASE");
    const o = magic.length;
    if (file.length < o + 44) throw new Error("wrong passphrase, or the file was damaged");
    const salt = file.subarray(o, o + 16);
    const iv = file.subarray(o + 16, o + 28);
    const tag = file.subarray(o + 28, o + 44);
    try {
      const decipher = createDecipheriv("aes-256-gcm", scryptSync(passphrase, salt, 32, magic === MAGIC_V2 ? SCRYPT_V2 : undefined), iv);
      decipher.setAuthTag(tag);
      packed = Buffer.concat([decipher.update(file.subarray(o + 44)), decipher.final()]);
    } catch { throw new Error("wrong passphrase, or the file was damaged"); }
  } else if (passphrase && !opts.allowUnsealed) {
    // A sealed file proves that someone who knows the passphrase wrote it (the checksum inside only detects accidents). With a passphrase
    // configured, a plain file is exactly what a forger would hand over.
    throw new Error("ORG_EXPORT_PASSPHRASE is set but this file is not encrypted, so nothing proves who wrote it. Refusing (pass --allow-unsealed only for a file you made yourself without a passphrase).");
  }
  let text: string;
  try { text = gunzipSync(packed, { maxOutputLength: opts.maxBytes ?? MAX_BUNDLE_BYTES }).toString("utf8"); }
  catch (e) { throw new Error(/larger than|maxOutputLength|ERR_BUFFER_TOO_LARGE/i.test(String((e as Error).message) + String((e as { code?: string }).code)) ? "the file unpacks to more than the allowed size; refusing" : "the file is not a valid organization export"); }
  return validateBundle(JSON.parse(text));
}
