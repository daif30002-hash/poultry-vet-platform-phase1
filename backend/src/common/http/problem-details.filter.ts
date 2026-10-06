import { ArgumentsHost, Catch, HttpException, Logger, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { DomainError } from '../../domain/errors.ts';
import {
  internalProblem,
  problemFromDomainError,
  problemFromStatus,
  type ProblemDetails,
} from '../../domain/http/problem-details.ts';
import type { ApiRequest } from '../auth/request-context.ts';

/** Every error leaves the API as RFC 7807 application/problem+json with a trace id. */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<ApiRequest>();
    const traceId = request.id ?? 'unknown';

    let problem: ProblemDetails;
    if (exception instanceof DomainError) {
      problem = problemFromDomainError(exception, traceId);
      if (problem.status >= 500) this.logger.error(`${traceId} ${exception.code}: ${exception.message}`);
    } else if (exception instanceof HttpException) {
      const body = exception.getResponse();
      const message = typeof body === 'string' ? body : (body as { message?: unknown }).message;
      problem = problemFromStatus(exception.getStatus(), traceId, Array.isArray(message) ? message.join('; ') : String(message ?? exception.message));
    } else {
      this.logger.error(`${traceId} unhandled error`, exception instanceof Error ? exception.stack : String(exception));
      problem = internalProblem(traceId);
    }
    response.status(problem.status).type('application/problem+json').json(problem);
  }
}
