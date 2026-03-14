import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import path from "path";
import fs from "fs";

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
  const runMigration = async () => {
    // FORCE RESET LOGIC: Only if RESET_DATABASE="true"
    if (process.env.RESET_DATABASE === "true") {
      console.log("⚠️ RESET_DATABASE is true. Starting emergency cleanup...");
      try {
        await db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE`);
        await db.execute(sql`CREATE SCHEMA public`);
        await db.execute(sql`GRANT ALL ON SCHEMA public TO postgres`);
        await db.execute(sql`GRANT ALL ON SCHEMA public TO public`);
        console.log("✅ Database wiped and public schema recreated.");
      } catch (e) {
        console.error("❌ Error during RESET_DATABASE:", e);
      }
    }

    const migrationsPath = path.resolve(process.cwd(), "drizzle");
    console.log(`🔍 Checking migrations at: ${migrationsPath}`);
    
    if (!fs.existsSync(migrationsPath)) {
      console.error(`❌ Migrations folder NOT FOUND at ${migrationsPath}`);
      return;
    }

    const files = fs.readdirSync(migrationsPath).filter(f => f.endsWith('.sql'));
    console.log(`📂 Found ${files.length} SQL migration files:`, files);

    console.log("🚀 Running database migrations...");
    await migrate(db, { 
      migrationsFolder: migrationsPath,
      migrationsTable: "drizzle_migrations" // Standard table name
    });
    console.log("✅ Migrations completed successfully");
  };

  runMigration().catch((err) => {
    console.error("❌ Migration failed critical error:", err);
  });
}
