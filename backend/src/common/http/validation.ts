import { ValidationPipe } from '@nestjs/common';
import type { ValidationError } from 'class-validator';
import { DomainError } from '../../domain/errors.ts';

function flatten(errors: readonly ValidationError[], parent = ''): { field: string; messages: string[] }[] {
  return errors.flatMap((error) => {
    const field = parent === '' ? error.property : `${parent}.${error.property}`;
    const own = error.constraints === undefined ? [] : [{ field, messages: Object.values(error.constraints) }];
    return [...own, ...flatten(error.children ?? [], field)];
  });
}

export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: (errors) =>
      new DomainError('VALIDATION_FAILED', 'request validation failed', { errors: flatten(errors) }),
  });
}
