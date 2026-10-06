import { Global, Logger, Module } from '@nestjs/common';
import pg from 'pg';
import { parseEnv, type Env } from '../config/env.ts';
import { TenantDb } from './tenant-db.service.ts';
import { APP_ENV, PG_POOL } from './tokens.ts';

@Global()
@Module({
  providers: [
    { provide: APP_ENV, useFactory: (): Env => parseEnv(process.env) },
    {
      provide: PG_POOL,
      inject: [APP_ENV],
      useFactory: (env: Env): pg.Pool => {
        const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: env.DB_POOL_MAX });
        pool.on('error', (error) => new Logger('PostgresPool').error(`idle client error: ${error.message}`));
        return pool;
      },
    },
    TenantDb,
  ],
  exports: [APP_ENV, PG_POOL, TenantDb],
})
export class DatabaseModule {}
