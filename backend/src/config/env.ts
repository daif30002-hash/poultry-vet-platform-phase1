import { DomainError } from '../domain/errors.ts';

export interface Env {
  readonly NODE_ENV: 'development' | 'test' | 'production';
  readonly PORT: number;
  readonly DATABASE_URL: string;
  readonly DB_POOL_MAX: number;
  readonly CORS_ORIGINS: readonly string[];
  readonly TRUST_PROXY: boolean;
  readonly OPENAPI_OUT: string | null;
}

type Source = Readonly<Record<string, string | undefined>>;

function integer(source: Source, key: string, fallback: number, min: number, max: number, errors: string[]): number {
  const raw = source[key];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    errors.push(`${key} must be an integer between ${min} and ${max}`);
    return fallback;
  }
  return value;
}

/** Validates the process environment once at start-up. Secrets have no defaults. */
export function parseEnv(source: Source): Env {
  const errors: string[] = [];

  const nodeEnvRaw = source['NODE_ENV'] ?? 'development';
  const nodeEnv: Env['NODE_ENV'] =
    nodeEnvRaw === 'production' || nodeEnvRaw === 'test' || nodeEnvRaw === 'development' ? nodeEnvRaw : 'development';
  if (nodeEnvRaw !== nodeEnv) errors.push('NODE_ENV must be development, test or production');

  const databaseUrl = source['DATABASE_URL'] ?? '';
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
    errors.push('DATABASE_URL is required and must start with postgres:// or postgresql://');
  } else if (nodeEnv === 'production' && /sslmode=disable/i.test(databaseUrl)) {
    errors.push('DATABASE_URL must not disable TLS in production');
  }

  const corsOrigins = (source['CORS_ORIGINS'] ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  if (corsOrigins.includes('*')) errors.push('CORS_ORIGINS must list explicit origins, not *');
  if (nodeEnv === 'production' && corsOrigins.length === 0) errors.push('CORS_ORIGINS is required in production');

  const port = integer(source, 'PORT', 3000, 1, 65535, errors);
  const poolMax = integer(source, 'DB_POOL_MAX', 10, 1, 100, errors);

  if (errors.length > 0) {
    throw new DomainError('VALIDATION_FAILED', 'invalid environment configuration', { errors });
  }

  const openapiOut = source['OPENAPI_OUT'];
  return {
    NODE_ENV: nodeEnv,
    PORT: port,
    DATABASE_URL: databaseUrl,
    DB_POOL_MAX: poolMax,
    CORS_ORIGINS: corsOrigins,
    TRUST_PROXY: source['TRUST_PROXY'] === 'true',
    OPENAPI_OUT: openapiOut !== undefined && openapiOut !== '' ? openapiOut : null,
  };
}
