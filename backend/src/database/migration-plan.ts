import { createHash } from 'node:crypto';

export interface MigrationFile {
  readonly version: string;
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

export interface AppliedMigration {
  readonly version: string;
  readonly checksum: string;
}

const FILENAME = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export function parseMigrationFilename(filename: string): { version: string; name: string } | null {
  const match = FILENAME.exec(filename);
  return match === null ? null : { version: match[1] as string, name: match[2] as string };
}

export function checksumOf(sql: string): string {
  return createHash('sha256').update(sql.replaceAll('\r\n', '\n'), 'utf8').digest('hex');
}

export function toMigrationFile(filename: string, sql: string): MigrationFile {
  const parsed = parseMigrationFilename(filename);
  if (parsed === null) throw new Error(`migration file name must look like 0001_name.sql: ${filename}`);
  return { ...parsed, sql, checksum: checksumOf(sql) };
}

export interface MigrationPlan {
  readonly pending: readonly MigrationFile[];
}

/**
 * Applied migrations are immutable and strictly ordered. The plan refuses to run when history and files disagree:
 * duplicate versions, gaps, edited files, missing files, or a new file older than the latest applied one.
 */
export function planMigrations(files: readonly MigrationFile[], applied: readonly AppliedMigration[]): MigrationPlan {
  const sorted = [...files].sort((a, b) => a.version.localeCompare(b.version));
  for (let i = 0; i < sorted.length; i += 1) {
    const current = sorted[i] as MigrationFile;
    if (i > 0 && (sorted[i - 1] as MigrationFile).version === current.version) {
      throw new Error(`duplicate migration version ${current.version}`);
    }
    if (Number(current.version) !== i + 1) {
      throw new Error(`migration versions must be contiguous starting at 0001; found ${current.version} at position ${i + 1}`);
    }
  }
  const byVersion = new Map(sorted.map((f) => [f.version, f] as const));
  for (const done of applied) {
    const file = byVersion.get(done.version);
    if (file === undefined) throw new Error(`applied migration ${done.version} has no file`);
    if (file.checksum !== done.checksum) throw new Error(`migration ${done.version} was modified after it was applied`);
  }
  const appliedVersions = new Set(applied.map((a) => a.version));
  const highestApplied = applied.reduce((max, a) => (a.version > max ? a.version : max), '');
  const pending = sorted.filter((f) => !appliedVersions.has(f.version));
  for (const file of pending) {
    if (file.version < highestApplied) {
      throw new Error(`migration ${file.version} is older than the latest applied migration ${highestApplied}`);
    }
  }
  return { pending };
}
