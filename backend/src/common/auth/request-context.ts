import type { Request } from 'express';
import type { AuthenticatedActor } from '../../domain/rbac/route-access.ts';

export interface ApiRequest extends Request {
  /** set by the authentication layer (M02); absent on unauthenticated requests */
  actor?: AuthenticatedActor;
  id?: string;
}
