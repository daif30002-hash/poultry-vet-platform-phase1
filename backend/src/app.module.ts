import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { PermissionsGuard } from './common/auth/permissions.guard.ts';
import { ProblemDetailsFilter } from './common/http/problem-details.filter.ts';
import { DatabaseModule } from './database/database.module.ts';
import { AuditModule } from './modules/audit/audit.module.ts';
import { HealthModule } from './modules/health/health.module.ts';

@Module({
  imports: [DatabaseModule, AuditModule, HealthModule],
  providers: [
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
  ],
})
export class AppModule {}
