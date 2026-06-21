// Structured JSON logging via pino with secret redaction.
import pino from 'pino';
import { randomUUID } from 'node:crypto';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  // Never leak credentials/secrets into logs.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'headers.authorization',
      'headers.cookie',
      'password',
      'totpSecret',
      'totp_secret',
      'secret',
      'hashedKey',
      'hashed_key',
      'apiKey',
      'token',
      '*.password',
      '*.totpSecret',
      '*.secret',
      '*.token',
    ],
    censor: '[REDACTED]',
  },
  base: { service: 'ierp-api' },
});

// Correlation id for a request/operation. Use to stamp logs + audit rows.
export function requestId(): string {
  return randomUUID();
}
