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
    } else if (isDriverError(exception)) {
      const mapped = mapDriverError(exception);
      status = mapped.status;
      body = mapped.body;
      // 23505/23503 etc. are expected contention/integrity outcomes, not bugs — warn, no stack spam.
      this.logger.warn(`db ${exception.code}: ${exception.message}`);
    } else if (exception instanceof Error) {
      this.logger.error(exception.message, exception.stack);
      body.message = exception.message;
    }

    res.status(status).send({ error: body });
  }
}

interface DriverError extends Error {
  code: string; // SQLSTATE, e.g. '23505'
  constraint_name?: string;
  detail?: string;
  table?: string;
}

// SQLSTATE is always 2 digits + 3 alphanumerics. Node's own error codes (ECONNREFUSED, ERR_*)
// don't match this shape, so they fall through to the generic Error branch.
function isDriverError(e: unknown): e is DriverError {
  return e instanceof Error && typeof (e as any).code === 'string' && /^[0-9]{2}[0-9A-Z]{3}$/.test((e as any).code);
}

function mapDriverError(e: DriverError): { status: number; body: { code: string; message: string; messageTh?: string } } {
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
    default: return 'ERROR';
  }
}
