import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checksumOf, parseMigrationFilename, planMigrations, toMigrationFile } from './migration-plan.ts';

const f = (name: string, sql = 'SELECT 1;') => toMigrationFile(name, sql);

describe('migration filenames', () => {
  it('accepts NNNN_snake_case.sql only', () => {
    assert.deepEqual(parseMigrationFilename('0001_extensions.sql'), { version: '0001', name: 'extensions' });
    assert.equal(parseMigrationFilename('1_x.sql'), null);
    assert.equal(parseMigrationFilename('0001-x.sql'), null);
    assert.equal(parseMigrationFilename('0001_X.sql'), null);
    assert.throws(() => toMigrationFile('bad.sql', ''));
  });

  it('checksums ignore line ending style', () => {
    assert.equal(checksumOf('a\r\nb'), checksumOf('a\nb'));
  });
});

describe('planMigrations', () => {
  const files = [f('0001_a.sql', 'A'), f('0002_b.sql', 'B'), f('0003_c.sql', 'C')];

  it('plans everything on a fresh database, in order', () => {
    assert.deepEqual(planMigrations([files[2], files[0], files[1]] as never, []).pending.map((x) => x.version), ['0001', '0002', '0003']);
  });

  it('plans only the missing tail', () => {
    const applied = files.slice(0, 2).map((x) => ({ version: x.version, checksum: x.checksum }));
    assert.deepEqual(planMigrations(files, applied).pending.map((x) => x.version), ['0003']);
    assert.equal(planMigrations(files, files.map((x) => ({ version: x.version, checksum: x.checksum }))).pending.length, 0);
  });

  it('refuses edited history', () => {
    assert.throws(() => planMigrations(files, [{ version: '0001', checksum: 'deadbeef' }]), /modified/);
  });

  it('refuses applied migrations whose file disappeared', () => {
    assert.throws(() => planMigrations(files.slice(0, 1), [{ version: '0002', checksum: 'x' }]), /no file/);
  });

  it('refuses gaps and duplicates', () => {
    assert.throws(() => planMigrations([f('0001_a.sql'), f('0003_c.sql')], []), /contiguous/);
    assert.throws(() => planMigrations([f('0001_a.sql'), f('0001_b.sql')], []), /duplicate/);
  });

  it('refuses a new file inserted before the latest applied one', () => {
    const late = [f('0001_a.sql', 'A'), f('0002_b.sql', 'B'), f('0003_c.sql', 'C')];
    assert.throws(() => planMigrations(late, [{ version: '0001', checksum: late[0]!.checksum }, { version: '0003', checksum: late[2]!.checksum }]), /older than/);
  });
});
