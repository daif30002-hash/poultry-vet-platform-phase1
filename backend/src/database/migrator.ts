import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { planMigrations, toMigrationFile, type AppliedMigration, type MigrationFile } from './migration-plan.ts';

export function loadMigrationFiles(directory: string): MigrationFile[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => toMigrationFile(name, readFileSync(join(directory, name), 'utf8')));
}

const LOCK_KEY = 'vet-platform-schema-migrations';

/** Applies pending migrations, each in its own transaction, under a session advisory lock. Returns how many ran. */
export async function migrate(connectionString: string, directory: string, log: (message: string) => void): Promise<number> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        name text NOT NULL,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const applied = (await client.query('SELECT version, checksum FROM schema_migrations ORDER BY version'))
      .rows as unknown as AppliedMigration[];
    const plan = planMigrations(loadMigrationFiles(directory), applied);
    for (const migration of plan.pending) {
      log(`applying ${migration.version}_${migration.name}`);
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [
          migration.version,
          migration.name,
          migration.checksum,
        ]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    return plan.pending.length;
  } finally {
    await client.end();
  }
}
