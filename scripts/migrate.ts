import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

/** Applies versioned migrations over the DIRECT (non-pooled) connection. */
export async function runMigrations(connectionString: string) {
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    await migrate(drizzle({ client: pool }), { migrationsFolder: "./drizzle" });
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL_UNPOOLED (or DATABASE_URL) is required");
  runMigrations(url).then(
    () => console.log("migrations applied"),
    (e) => {
      console.error("migration failed:", e instanceof Error ? e.message : e);
      process.exit(1);
    },
  );
}
