import { randomUUID } from 'node:crypto';
import type { NextFunction, Response } from 'express';
import type { ApiRequest } from '../auth/request-context.ts';

const SAFE_ID = /^[A-Za-z0-9._-]{8,64}$/;

export function requestIdMiddleware(request: ApiRequest, response: Response, next: NextFunction): void {
  const incoming = request.header('x-request-id');
  const id = incoming !== undefined && SAFE_ID.test(incoming) ? incoming : randomUUID();
  request.id = id;
  response.setHeader('X-Request-Id', id);
  next();
}
