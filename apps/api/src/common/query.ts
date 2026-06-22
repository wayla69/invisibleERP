import { BadRequestException } from '@nestjs/common';

// Safe coercion for numeric query params. Bare `+value`/`Number(value)` silently yields NaN for junk
// input (e.g. ?limit=abc), which then flows into LIMIT/OFFSET/amount math. These return a clean 400 with
// the standard envelope instead.

function bad(name: string, value: string, kind: string): never {
  throw new BadRequestException({ code: 'BAD_QUERY', message: `Query param "${name}" must be ${kind} (got "${value}")`, messageTh: `พารามิเตอร์ "${name}" ไม่ถูกต้อง` });
}

// Optional integer with a default when the param is absent/empty.
export function qint(name: string, value: string | undefined, fallback: number): number {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) bad(name, value, 'an integer');
  return n;
}

// Optional integer that stays undefined when absent (for "all"/no-filter semantics).
export function qintOpt(name: string, value: string | undefined): number | undefined {
  if (value == null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) bad(name, value, 'an integer');
  return n;
}

// Required finite number (no default) — for amounts.
export function qnum(name: string, value: string | undefined): number {
  if (value == null || value === '') bad(name, String(value), 'a number');
  const n = Number(value);
  if (!Number.isFinite(n)) bad(name, value as string, 'a number');
  return n;
}
