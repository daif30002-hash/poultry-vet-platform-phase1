import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import type { Pool } from 'pg';
import { DomainError } from '../domain/errors.ts';
import { PG_POOL } from './tokens.ts';
import type { Queryable } from './queryable.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Every tenant scoped query runs through withTenant: one transaction, tenant set with set_config(..., true)
 * so it cannot outlive the transaction, and row level security does the isolation.
 */
@Injectable()
export class TenantDb implements OnApplicationShutdown {
  private closed = false;

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async withTenant<T>(companyId: string, work: (tx: Queryable) => Promise<T>): Promise<T> {
    if (!UUID.test(companyId)) {
      throw new DomainError('VALIDATION_FAILED', 'companyId must be a lowercase uuid');
    }
    const client = await this.pool.connect();
    const tx: Queryable = {
      query: (text, values) => client.query(text, values),
    };
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.company_id', $1, true)", [companyId]);
      const result = await work(tx);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // the original error is the one worth reporting
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /** Pre-authentication lookup: maps the public company slug to its id (ACTIVE companies only). */
  async resolveCompanyBySlug(slug: string): Promise<string | null> {
    const result = await this.pool.query('SELECT resolve_company_by_slug($1) AS id', [slug]);
    const id = (result.rows[0] as { id: string | null } | undefined)?.id;
    return id ?? null;
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async onApplicationShutdown(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      await this.pool.end();
    }
  }
}
