import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

/**
 * Production migrations: `pnpm db:generate` writes SQL to ./drizzle from schema changes,
 * commit them, then `pnpm db:migrate` applies pending ones. `db:push` stays for local dev only.
 */
async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for migrations');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : undefined });
  const db = drizzle(pool);
  try { await migrate(db, { migrationsFolder: './drizzle' }); }
  finally { await pool.end(); }
  // eslint-disable-next-line no-console
  console.log('migrations applied');
}
main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
