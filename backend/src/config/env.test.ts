import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnv } from './env.ts';
import { DomainError } from '../domain/errors.ts';

const valid = { DATABASE_URL: 'postgresql://vet_app:secret@localhost:5432/vet' };

function errorsOf(source: Record<string, string | undefined>): string[] {
  try {
    parseEnv(source);
  } catch (e) {
    if (e instanceof DomainError) return e.details['errors'] as string[];
    throw e;
  }
  return [];
}

describe('parseEnv', () => {
  it('parses a minimal development environment', () => {
    const env = parseEnv(valid);
    assert.equal(env.NODE_ENV, 'development');
    assert.equal(env.PORT, 3000);
    assert.equal(env.DB_POOL_MAX, 10);
    assert.deepEqual(env.CORS_ORIGINS, []);
    assert.equal(env.OPENAPI_OUT, null);
  });

  it('has no default for the database url', () => {
    assert.equal(errorsOf({}).length, 1);
    assert.equal(errorsOf({ DATABASE_URL: 'mysql://x' }).length, 1);
  });

  it('is strict in production', () => {
    const errs = errorsOf({ NODE_ENV: 'production', DATABASE_URL: 'postgres://u:p@h/db?sslmode=disable' });
    assert.equal(errs.length, 2);
    assert.deepEqual(
      errorsOf({ NODE_ENV: 'production', DATABASE_URL: 'postgres://u:p@h/db?sslmode=require', CORS_ORIGINS: 'https://admin.example.org' }),
      [],
    );
  });

  it('refuses wildcard CORS and bad numbers, reporting all problems at once', () => {
    const errs = errorsOf({ ...valid, CORS_ORIGINS: '*', PORT: '99999', DB_POOL_MAX: 'ten', NODE_ENV: 'staging' });
    assert.equal(errs.length, 4);
  });

  it('splits and trims CORS origins', () => {
    assert.deepEqual(parseEnv({ ...valid, CORS_ORIGINS: ' https://a.org , https://b.org,' }).CORS_ORIGINS, ['https://a.org', 'https://b.org']);
  });
});
