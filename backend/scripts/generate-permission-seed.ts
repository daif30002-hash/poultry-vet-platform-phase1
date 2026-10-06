import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderPermissionSeedSql } from '../src/domain/rbac/seed-sql.ts';

// Applied migrations are immutable, so this only creates the initial seed and never overwrites it.
// run from the backend directory
const target = join(process.cwd(), 'migrations', '0004_seed_permissions_and_system_roles.sql');
if (existsSync(target)) {
  process.stderr.write('0004 already exists; permission catalog changes must ship as a new migration\n');
  process.exit(1);
}
writeFileSync(target, renderPermissionSeedSql());
process.stdout.write('created migrations/0004_seed_permissions_and_system_roles.sql\n');
