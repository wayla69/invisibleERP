import { ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { pgError, type PgErrorLike } from './db-error';

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
      messageTh: 'เกิดข้อผิดพลาด',
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
    } else if (pgError(exception)) {
      // drizzle 0.45 wraps the driver error (SQLSTATE under `.cause`); pgError() unwraps it so the
      // SQLSTATE→HTTP mapping (23505→409, …) keeps working — otherwise every integrity error became a 500.
      const drv = pgError(exception)!;
      const mapped = mapDriverError(drv);
      status = mapped.status;
      body = mapped.body;
      // 23505/23503 etc. are expected contention/integrity outcomes, not bugs — warn, no stack spam.
      this.logger.warn(`db ${drv.code}: ${drv.message ?? ''}`);
    } else if (exception instanceof Error) {
      // Log the real message + stack server-side, but DO NOT echo exception.message to the client:
      // raw internal messages can leak infra detail (internal hosts/IPs, file paths, library text).
      // The generic `body` ('Unexpected error') is returned instead.
      this.logger.error(exception.message, exception.stack);
    }

    res.status(status).send({ error: body });
  }
}

function mapDriverError(e: PgErrorLike): { status: number; body: { code: string; message: string; messageTh?: string } } {
  switch (e.code) {
    case '23505': // unique_violation
      return { status: HttpStatus.CONFLICT, body: { code: 'CONFLICT', message: 'Resource already exists', messageTh: 'ข้อมูลนี้มีอยู่แล้ว' } };
    case '23503': // foreign_key_violation
      return { status: HttpStatus.BAD_REQUEST, body: { code: 'FK_VIOLATION', message: 'Referenced record does not exist', messageTh: 'อ้างอิงข้อมูลที่ไม่มีอยู่' } };
    case '23502': // not_null_violation
      return { status: HttpStatus.BAD_REQUEST, body: { code: 'BAD_REQUEST', message: 'Missing required field', messageTh: 'ข้อมูลที่จำเป็นไม่ครบ' } };
    case '23514': // check_violation
      return { status: HttpStatus.BAD_REQUEST, body: { code: 'CHECK_VIOLATION', message: 'Value failed a constraint', messageTh: 'ค่าที่กรอกไม่ถูกต้อง' } };
    default: // unknown SQLSTATE stays a 500 so it is not silently masked as a 4xx
      return { status: HttpStatus.INTERNAL_SERVER_ERROR, body: { code: 'INTERNAL_ERROR', message: 'Unexpected error', messageTh: 'เกิดข้อผิดพลาด' } };
  }
}

function codeFor(status: number): string {
  switch (status) {
    case 400: return 'BAD_REQUEST';
    case 401: return 'UNAUTHORIZED';
    case 403: return 'FORBIDDEN';
    case 404: return 'NOT_FOUND';
    case 409: return 'CONFLICT';
    case 422: return 'UNPROCESSABLE';
    default: return 'ERROR';
  }
}
