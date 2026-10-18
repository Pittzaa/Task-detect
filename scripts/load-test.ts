import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { hashPassword } from "better-auth/crypto";
import pg from "pg";
import { syncSystemRoles } from "../src/data/system-roles";
import { createDb } from "../src/db/client";
import { runMigrations } from "./migrate";

/**
 * Load test against a PRODUCTION BUILD (`pnpm build` first) on a throw-away database filled with realistic volume.
 *
 *   pnpm load                              # 3 organizations x 60 users x 20 000 tasks, 10 then 50 concurrent users, 20 s each
 *   pnpm load --tasks 5000 --concurrency 5,20 --duration 10
 *   pnpm load --skip-seed                  # reuse the database from the previous run
 *
 * What it is for: finding algorithmic problems (N+1 queries, missing indexes, lock contention) and giving the approximate cost of each
 * screen's requests under concurrency. What it is NOT: a capacity statement. It runs one Node process and PostgreSQL on the same machine
 * with no network latency, so absolute numbers say nothing about Vercel + Neon. Only the shape (which requests are slow, whether
 * latency explodes with concurrency, whether anything errors) transfers.
 *
 * The database is named tasktracker_load and is dropped and rebuilt unless --skip-seed is given. It refuses any other name.
 */
const { values } = parseArgs({
  options: {
    orgs: { type: "string", default: "3" }, users: { type: "string", default: "60" }, tasks: { type: "string", default: "20000" },
    concurrency: { type: "string", default: "10,50" }, duration: { type: "string", default: "20" },
    "skip-seed": { type: "boolean" }, port: { type: "string", default: "3200" },
  },
});
const ORGS = Number(values.orgs), USERS = Number(values.users), TASKS = Number(values.tasks), DURATION = Number(values.duration) * 1000;
const LEVELS = values.concurrency!.split(",").map(Number);
const PORT = Number(values.port);
const DB = "tasktracker_load", ROLE = "tt_app_load", PASSWORD = "load-test-password-1";
const ADMIN_BASE = process.env.LOAD_DB_ADMIN_URL ?? "postgres://postgres@127.0.0.1:54329/postgres";
const PROJECTS = 20, TEAMS = 5, LABELS = 30;
const OUT_DIR = ".data/load";

const url = (user?: string, pass?: string) => { const u = new URL(ADMIN_BASE); u.pathname = `/${DB}`; if (user) { u.username = user; u.password = pass ?? ""; } return u.toString(); };
// Deterministic, valid version-4-shaped UUIDs (Better Auth validates ids; a raw md5 is not a valid UUID). Must match pg_temp.id() in seed().
const md5uuid = (s: string) => { const h = createHash("md5").update(s).digest("hex"); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20)}`; };
let orgIds: string[] = Array.from({ length: ORGS }, () => randomUUID());

// ---------------------------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------------------------

async function build() {
  const root = new pg.Client({ connectionString: ADMIN_BASE });
  await root.connect();
  await root.query(`drop database if exists ${DB} with (force)`);
  await root.query(`create database ${DB}`);
  await root.end();
  await runMigrations(url());
  const a = new pg.Client({ connectionString: url() });
  await a.connect();
  await a.query(`drop role if exists ${ROLE}`).catch(() => undefined);
  await a.query(`create role ${ROLE} login password 'app' nosuperuser nobypassrls`);
  await a.query(readFileSync("scripts/grants.sql", "utf8").replaceAll("{{APP_ROLE}}", ROLE));
  await a.end();
  const { db, close } = createDb(url());
  try { await syncSystemRoles(db); } finally { await close(); }
}

async function seed() {
  const hash = await hashPassword(PASSWORD);
  const c = new pg.Client({ connectionString: url() });
  await c.connect();
  const t0 = Date.now();
  try {
    await c.query(`create function pg_temp.id(text) returns uuid language sql immutable as $$ select (substr(h, 1, 12) || '4' || substr(h, 14, 3) || '8' || substr(h, 18, 15))::uuid from (select md5($1) as h) s $$`);
    const role = Object.fromEntries((await c.query("select key, id from roles where org_id is null")).rows.map((r) => [r.key, r.id as string]));
    for (let o = 0; o < ORGS; o++) {
      const org = orgIds[o]!;
      // The organization id is a generated UUID, so it is embedded as a literal (a bound parameter would have to be both uuid and text).
      const q = (text: string, params: unknown[] = []) => c.query(text.replaceAll("$1", `'${org}'`).replace(/\$(\d+)/g, (_m, d: string) => `$${Number(d) - 1}`), params);
      await q("insert into organizations (id, name, slug) values ($1, $2, $3)", [`Load Org ${o + 1}`, `load-${o + 1}`]);
      await q("insert into departments (id, org_id, name) values (pg_temp.id($1||'d'), $1, 'Dept')");
      await q(`insert into teams (id, org_id, department_id, name) select pg_temp.id($1||'t'||g), $1, pg_temp.id($1||'d'), 'Team '||g from generate_series(1, ${TEAMS}) g`);
      await q(`insert into projects (id, org_id, name) select pg_temp.id($1||'p'||g), $1, 'Project '||g from generate_series(1, ${PROJECTS}) g`);
      await q(`insert into project_teams (org_id, project_id, team_id) select $1, pg_temp.id($1||'p'||g), pg_temp.id($1||'t'||(1 + g % ${TEAMS})) from generate_series(1, ${PROJECTS}) g`);
      await q(`insert into project_teams (org_id, project_id, team_id) select $1, pg_temp.id($1||'p'||g), pg_temp.id($1||'t'||(1 + (g + 1) % ${TEAMS})) from generate_series(1, ${PROJECTS}) g`);
      await q(`insert into labels (id, org_id, name) select pg_temp.id($1||'l'||g), $1, 'label-'||g from generate_series(1, ${LABELS}) g`);

      await q(`insert into users (id, email, name, email_verified) select pg_temp.id($1||'u'||g), 'load-${o + 1}-'||g||'@load.test', 'User '||g||' ' || (array['Somchai','Suda','Anan','Mali','Prasert'])[1 + g % 5], true from generate_series(1, ${USERS}) g`);
      await q(`insert into auth_accounts (account_id, provider_id, user_id, password) select pg_temp.id($1||'u'||g)::text, 'credential', pg_temp.id($1||'u'||g), $2 from generate_series(1, ${USERS}) g`, [hash]);
      await q(`insert into memberships (id, org_id, user_id, status, approved_at) select pg_temp.id($1||'m'||g), $1, pg_temp.id($1||'u'||g), 'approved', now() from generate_series(1, ${USERS}) g`);
      const orgwide = Math.floor(USERS * 0.7), teamwide = Math.floor(USERS * 0.9);
      await q(`insert into role_assignments (org_id, membership_id, role_id, scope_type) values ($1, pg_temp.id($1||'m1'), $2, 'organization')`, [role.orgadmin]);
      await q(`insert into role_assignments (org_id, membership_id, role_id, scope_type) select $1, pg_temp.id($1||'m'||g), $2, 'organization' from generate_series(2, ${orgwide}) g`, [role.member]);
      await q(`insert into role_assignments (org_id, membership_id, role_id, scope_type, team_id) select $1, pg_temp.id($1||'m'||g), $2, 'team', pg_temp.id($1||'t'||(1 + g % ${TEAMS})) from generate_series(${orgwide + 1}, ${teamwide}) g`, [role.member]);
      await q(`insert into role_assignments (org_id, membership_id, role_id, scope_type, project_id) select $1, pg_temp.id($1||'m'||g), $2, 'project', pg_temp.id($1||'p'||(1 + g % ${PROJECTS})) from generate_series(${teamwide + 1}, ${USERS}) g`, [role.viewer]);

      const roots = `n % 7 <> 0 or n + 20 > ${TASKS}`;
      const cols = `id, org_id, project_id, parent_id, title, description, status, priority, start_date, due_date, completed_at, primary_assignee_id, created_by, created_at, updated_at`;
      const body = (parent: string) => `select pg_temp.id($1||'k'||n), $1, pg_temp.id($1||'p'||(1 + n % ${PROJECTS})), ${parent},
          'Task '||n||' '||(array['design','review','deploy','เอกสาร','ประชุม','report','bug','สรุปงาน'])[1 + n % 8],
          repeat('Lorem ipsum dolor sit amet. ', 6),
          (array['todo','todo','todo','progress','progress','review','done','done','done','cancelled'])[1 + n % 10]::task_status,
          (array['low','medium','medium','high','urgent'])[1 + n % 5]::task_priority,
          current_date + ((n % 120) - 60 - (n % 10)), current_date + ((n % 120) - 60),
          case when n % 10 in (6, 7, 8) then now() - make_interval(days => n % 30) end,
          pg_temp.id($1||'u'||(1 + n % ${USERS})), pg_temp.id($1||'u'||(1 + (n * 7) % ${USERS})),
          now() - make_interval(mins => ${TASKS} - n), now() - make_interval(mins => (${TASKS} - n) / 2)
        from generate_series(1, ${TASKS}) n`;
      await q(`insert into tasks (${cols}) ${body("null::uuid")} where ${roots}`);
      await q(`insert into tasks (${cols}) ${body("pg_temp.id($1||'k'||(n + 20))")} where not (${roots})`);
      await q(`insert into task_assignees (org_id, task_id, user_id) select $1, pg_temp.id($1||'k'||n), pg_temp.id($1||'u'||(1 + (n * 11) % ${USERS})) from generate_series(1, ${TASKS}) n where n % 3 = 0 and (1 + (n * 11) % ${USERS}) <> (1 + n % ${USERS})`);
      await q(`insert into task_labels (org_id, task_id, label_id) select $1, pg_temp.id($1||'k'||n), pg_temp.id($1||'l'||(1 + n % ${LABELS})) from generate_series(1, ${TASKS}) n where n % 3 = 0`);
      await q(`insert into task_dependencies (org_id, task_id, depends_on_id) select $1, pg_temp.id($1||'k'||n), pg_temp.id($1||'k'||(n + 1)) from generate_series(50, ${TASKS - 1}, 50) n`);
      await q(`insert into comments (org_id, task_id, author_id, body) select $1, pg_temp.id($1||'k'||n), pg_temp.id($1||'u'||(1 + (n + c) % ${USERS})), 'Comment '||c||' on task '||n||' — looks good, please review.' from generate_series(1, ${TASKS}) n, generate_series(1, 3) c where n % 3 = 0`);
      await q(`insert into task_activity (org_id, task_id, actor_id, type) select $1, pg_temp.id($1||'k'||n), pg_temp.id($1||'u'||(1 + n % ${USERS})), 'created' from generate_series(1, ${TASKS}) n where n % 2 = 0`);
      await q(`insert into audit_logs (org_id, actor_user_id, action, target_type, target_id) select $1, pg_temp.id($1||'u'||(1 + n % ${USERS})), 'task.create', 'task', pg_temp.id($1||'k'||(1 + n % ${TASKS})) from generate_series(1, ${Math.floor(TASKS * 1.25)}) n`);
      await q(`insert into notifications (org_id, user_id, type, task_id, dedupe_key, read_at) select $1, pg_temp.id($1||'u'||u), 'task.assigned', pg_temp.id($1||'k'||(1 + (u * 31 + g * 17) % ${TASKS})), 'seed-'||g, case when g % 4 = 0 then now() end from generate_series(1, ${USERS}) u, generate_series(1, 200) g`);
      console.log(`  seeded organization ${o + 1}/${ORGS}`);
    }
    await c.query("analyze");
    const counts = (await c.query("select (select count(*) from tasks) tasks, (select count(*) from comments) comments, (select count(*) from audit_logs) audit, (select count(*) from notifications) notifications, (select count(*) from users) users")).rows[0];
    console.log(`seeded in ${((Date.now() - t0) / 1000).toFixed(1)} s:`, counts);
  } finally { await c.end(); }
}

// ---------------------------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------------------------

async function startServer(): Promise<ChildProcess> {
  mkdirSync(OUT_DIR, { recursive: true });
  const log = openSync(`${OUT_DIR}/server.log`, "w");
  const child = spawn("pnpm", ["exec", "next", "start", "-p", String(PORT)], {
    stdio: ["ignore", log, log],
    env: {
      ...process.env, APP_ENV: "e2e", APP_URL: `http://localhost:${PORT}`, DATABASE_URL: url(ROLE, "app"), BETTER_AUTH_SECRET: "load-secret-load-secret-load-secret-0000",
      APP_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"), EMAIL_SINK_FILE: `${OUT_DIR}/emails.jsonl`, CRON_SECRET: "load-cron-secret-123456", BLOB_READ_WRITE_TOKEN: "", LOG_LEVEL: "warn",
    },
  });
  writeFileSync(`${OUT_DIR}/server.pid`, String(child.pid));
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`http://localhost:${PORT}/api/health`)).ok) return child; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw new Error(`the server did not start; see ${OUT_DIR}/server.log (did you run pnpm build?)`);
}

// ---------------------------------------------------------------------------------------------
// Virtual users
// ---------------------------------------------------------------------------------------------

interface Sample { action: string; ms: number; status: number }
interface Vu { orgId: string; cookie: string; userIndex: number; orgIndex: number }
const BASE = `http://localhost:${PORT}`;

async function signIn(orgIndex: number, userIndex: number): Promise<Vu> {
  const res = await fetch(`${BASE}/api/auth/sign-in/email`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ email: `load-${orgIndex + 1}-${userIndex}@load.test`, password: PASSWORD }) });
  if (!res.ok) throw new Error(`sign-in failed for load-${orgIndex + 1}-${userIndex}: ${res.status} ${await res.text()}`);
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  return { orgId: orgIds[orgIndex]!, cookie, userIndex, orgIndex };
}

const pick = <T>(xs: readonly T[]) => xs[Math.floor(Math.random() * xs.length)]!;
const WEIGHTED: [string, number][] = [
  ["list", 28], ["mine", 14], ["task", 12], ["comments", 12], ["changes", 12], ["notifications", 7], ["dashboard", 4], ["search", 3], ["timeline", 3], ["people", 2], ["context", 3], ["write-status", 1], ["write-comment", 1],
];
const TOTAL_WEIGHT = WEIGHTED.reduce((n, [, w]) => n + w, 0);
function chooseAction() { let r = Math.random() * TOTAL_WEIGHT; for (const [a, w] of WEIGHTED) { if ((r -= w) < 0) return a; } return "list"; }

async function runLevel(concurrency: number, vus: Vu[], samples: Sample[], changed: Set<number>) {
  const stop = Date.now() + DURATION;
  const plus = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  await Promise.all(vus.slice(0, concurrency).map(async (vu) => {
    const org = `${BASE}/api/orgs/${vu.orgId}`;
    const taskId = (n: number) => md5uuid(`${vu.orgId}k${n}`);
    const call = async (action: string, path: string, init: { method?: string; body?: unknown } = {}) => {
      const t = performance.now();
      let status = 0;
      try {
        const res = await fetch(`${org}${path}`, { method: init.method ?? "GET", headers: { cookie: vu.cookie, origin: BASE, ...(init.body ? { "content-type": "application/json" } : {}) }, body: init.body ? JSON.stringify(init.body) : undefined });
        await res.arrayBuffer();
        status = res.status;
      } catch { status = 0; }
      samples.push({ action, ms: performance.now() - t, status });
    };
    while (Date.now() < stop) {
      const action = chooseAction();
      const n = 1 + Math.floor(Math.random() * TASKS);
      switch (action) {
        case "list": await call(action, `/tasks?limit=50&sort=due${Math.random() < 0.4 ? `&status=${pick(["todo", "progress", "review"])}` : ""}${Math.random() < 0.3 ? `&projectId=${md5uuid(`${vu.orgId}p${1 + Math.floor(Math.random() * PROJECTS)}`)}` : ""}`); break;
        case "mine": await call(action, "/tasks?assignee=me&status=todo,progress,review,blocked&sort=due&limit=100"); break;
        case "task": await call(action, `/tasks/${taskId(n)}`); break;
        case "comments": await call(action, `/tasks/${taskId(3 * Math.ceil(n / 3))}/comments`); break;
        case "changes": await call(action, "/changes"); break;
        case "notifications": await call(action, "/notifications?limit=15"); break;
        case "dashboard": await call(action, "/dashboard"); break;
        case "search": await call(action, `/search?q=${encodeURIComponent(pick(["Task 1", "design", "deploy", "report", "ประชุม"]))}`); break;
        case "timeline": await call(action, `/timeline?from=${plus(-30)}&to=${plus(30)}`); break;
        case "people": await call(action, `/projects/${md5uuid(`${vu.orgId}p${1 + Math.floor(Math.random() * PROJECTS)}`)}/people`); break;
        case "context": await call(action, "/context"); break;
        case "write-status": {
          const m = 10 * Math.floor(Math.random() * (TASKS / 10 - 2)) + 1 + (Math.random() < 0.5 ? 0 : 1); // a "todo" task (n % 10 in 0..3)
          if (changed.has(m * 1000 + vu.orgIndex)) break;
          changed.add(m * 1000 + vu.orgIndex);
          await call(action, `/tasks/${taskId(m)}/status`, { method: "POST", body: { status: "progress" } });
          break;
        }
        case "write-comment": await call(action, `/tasks/${taskId(n)}/comments`, { method: "POST", body: { body: "load test comment" } }); break;
      }
    }
  }));
}

function pct(sorted: number[], p: number) { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]! : 0; }

function report(level: number, samples: Sample[], seconds: number) {
  const byAction = new Map<string, Sample[]>();
  for (const s of samples) (byAction.get(s.action) ?? byAction.set(s.action, []).get(s.action)!).push(s);
  const isWrite = (a: string) => a.startsWith("write-");
  const bad = (s: Sample) => s.status === 0 || s.status >= 500 || (!isWrite(s.action) && s.status >= 400 && s.status !== 429);
  const errors = samples.filter(bad);
  const throttled = samples.filter((s) => s.status === 429).length;
  console.log(`\n=== ${level} concurrent users, ${seconds.toFixed(0)} s: ${samples.length} requests, ${(samples.length / seconds).toFixed(1)} req/s, ${errors.length} errors (5xx / network / unexpected 4xx), ${throttled} rate-limited (429) ===`);
  console.log("action".padEnd(15) + "n".padStart(7) + "p50".padStart(8) + "p95".padStart(8) + "p99".padStart(8) + "max".padStart(8) + "  errors");
  const rows = [];
  for (const [a, xs] of [...byAction].sort()) {
    const ms = xs.map((x) => x.ms).sort((x, y) => x - y);
    const errs = xs.filter(bad);
    console.log(a.padEnd(15) + String(xs.length).padStart(7) + pct(ms, 50).toFixed(0).padStart(8) + pct(ms, 95).toFixed(0).padStart(8) + pct(ms, 99).toFixed(0).padStart(8) + ms[ms.length - 1]!.toFixed(0).padStart(8) + (errs.length ? `  ${errs.length} (${[...new Set(errs.map((e) => e.status))].join(",")})` : ""));
    rows.push({ action: a, n: xs.length, p50: pct(ms, 50), p95: pct(ms, 95), p99: pct(ms, 99), max: ms[ms.length - 1], errors: errs.length });
  }
  return { level, requests: samples.length, rps: samples.length / seconds, errors: errors.length, rateLimited: throttled, rows };
}

async function main() {
  if (!values["skip-seed"]) { console.log("building the database …"); await build(); console.log("seeding …"); await seed(); }
  else {
    // reuse: the organizations were given random ids by the earlier run; read them back (slugs are load-1, load-2, …)
    const c = new pg.Client({ connectionString: url() });
    await c.connect();
    const rows = (await c.query("select id, slug from organizations where slug like 'load-%' order by slug")).rows as { id: string; slug: string }[];
    await c.end();
    if (!rows.length) throw new Error("--skip-seed needs the database of an earlier run");
    orgIds = rows.slice(0, ORGS).map((r) => r.id);
  }
  console.log("starting the server …");
  const server = await startServer();
  const results = [];
  try {
    const maxLevel = Math.max(...LEVELS);
    console.log(`signing in ${maxLevel} users …`);
    const vus: Vu[] = [];
    for (let i = 0; i < maxLevel; i++) vus.push(await signIn(i % ORGS, 2 + Math.floor(i / ORGS) % (USERS - 1)));
    const warm = performance.now();
    await runLevel(Math.min(5, maxLevel), vus, [], new Set()); // warm-up: JIT, connection pools, plan caches (not reported)
    console.log(`warm-up ${((performance.now() - warm) / 1000).toFixed(0)} s done`);
    const changed = new Set<number>();
    for (const level of LEVELS) {
      const samples: Sample[] = [];
      const t = performance.now();
      await runLevel(level, vus, samples, changed);
      results.push(report(level, samples, (performance.now() - t) / 1000));
    }
  } finally {
    server.kill();
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const file = `${OUT_DIR}/result-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), orgs: ORGS, users: USERS, tasksPerOrg: TASKS, duration: DURATION / 1000, results }, null, 2));
  console.log(`\nresult written to ${file}`);
  process.exit(results.some((r) => r.errors > 0) ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
