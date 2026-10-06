import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DomainError } from '../../domain/errors.ts';
import { decideRouteAccess, type DeniedCode, type RouteDeclaration } from '../../domain/rbac/route-access.ts';
import { ROUTE_DECLARATION_KEY } from './decorators.ts';
import type { ApiRequest } from './request-context.ts';

const MESSAGES: Readonly<Record<DeniedCode, string>> = {
  UNAUTHENTICATED: 'authentication is required',
  PERMISSION_DENIED: 'permission denied',
  STEP_UP_REQUIRED: 'a fresh step-up verification is required',
  ENDPOINT_UNDECLARED: 'this endpoint declares no access rule and is closed',
};

/** Global guard. Permissions come from the server side actor only; nothing sent by the client is trusted. */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const declaration =
      this.reflector.getAllAndOverride<RouteDeclaration | undefined>(ROUTE_DECLARATION_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? null;
    const request = context.switchToHttp().getRequest<ApiRequest>();
    const decision = decideRouteAccess(request.actor ?? null, declaration, Date.now());
    if (decision.allowed) return true;
    throw new DomainError(decision.code, MESSAGES[decision.code]);
  }
}
