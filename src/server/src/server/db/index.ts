import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import path from "path";

import { env } from "~/env";
import * as schema from "./schema";

/**
 * Cache the database connection in development. This avoids creating a new connection on every HMR
 * update.
 */
const globalForDb = globalThis as unknown as {
  conn: postgres.Sql | undefined;
};

const conn =
  globalForDb.conn ??
  postgres(env.DATABASE_URL, {
    ssl: {
      rejectUnauthorized: false,
    },
    max: 1,
  });
if (env.NODE_ENV !== "production") globalForDb.conn = conn;

export const db = drizzle(conn, { schema });

// Run migrations in production automatically
if (env.NODE_ENV === "production" || process.env.RUN_MIGRATIONS === "true") {
  console.log("Running database migrations...");
  migrate(db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") })
    .then(() => console.log("Migrations completed successfully"))
    .catch((err) => {
      console.error("Migration failed:", err);
    });
}
