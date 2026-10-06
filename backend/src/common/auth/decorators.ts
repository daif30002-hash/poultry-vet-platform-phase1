import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { PermissionCode } from '../../domain/rbac/permission-catalog.ts';
import type { RouteDeclaration } from '../../domain/rbac/route-access.ts';
import type { ApiRequest } from './request-context.ts';

export const ROUTE_DECLARATION_KEY = 'vet:route-declaration';

/** Explicitly public route (login, health, ...). Every route must carry either this or RequirePermission. */
export const Public = () => SetMetadata(ROUTE_DECLARATION_KEY, { kind: 'PUBLIC' } satisfies RouteDeclaration);

export const RequirePermission = (permission: PermissionCode, options: { stepUp?: boolean } = {}) =>
  SetMetadata(ROUTE_DECLARATION_KEY, {
    kind: 'PERMISSION',
    requirement: { permission, stepUp: options.stepUp },
  } satisfies RouteDeclaration);

export const CurrentActor = createParamDecorator((_data: unknown, context: ExecutionContext) =>
  context.switchToHttp().getRequest<ApiRequest>().actor,
);
