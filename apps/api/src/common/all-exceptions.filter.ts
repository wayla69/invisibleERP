import { ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

// Error envelope สม่ำเสมอ: { error: { code, message, messageTh? } }
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<FastifyReply>();
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let body: { code: string; message: string; messageTh?: string } = {
      code: 'INTERNAL_ERROR',
      message: 'Unexpected error',
    };

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const r = exception.getResponse();
      if (typeof r === 'string') {
        body = { code: codeFor(status), message: r };
      } else if (r && typeof r === 'object') {
        const o = r as Record<string, unknown>;
        body = {
          code: (o.code as string) ?? codeFor(status),
          message: (o.message as string) ?? exception.message,
          messageTh: o.messageTh as string | undefined,
        };
      }
    } else if (exception instanceof Error) {
      this.logger.error(exception.message, exception.stack);
      body.message = exception.message;
    }

    res.status(status).send({ error: body });
  }
}

function codeFor(status: number): string {
  switch (status) {
    case 400: return 'BAD_REQUEST';
    case 401: return 'UNAUTHORIZED';
    case 403: return 'FORBIDDEN';
    case 404: return 'NOT_FOUND';
    case 409: return 'CONFLICT';
    default: return 'ERROR';
  }
}
