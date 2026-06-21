// Type coercion สำหรับ SQLite (dynamic typing, text dates) → Postgres types.

export function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

export function num(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : null;
}

export function int(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
}

export function bool(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'boolean') return v;
  const s = String(v).toLowerCase();
  return s === '1' || s === 'true' || s === 'yes';
}

// → 'YYYY-MM-DD' | null  (สำหรับ drizzle date columns)
export function dstr(v: unknown): string | null {
  const d = parseDate(v);
  if (!d) return null;
  return d.toISOString().slice(0, 10);
}

// → Date | null  (สำหรับ drizzle timestamp columns)
export function ts(v: unknown): Date | null {
  return parseDate(v);
}

function parseDate(v: unknown): Date | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const s = String(v).trim();
  if (!s) return null;

  // ISO-ish: YYYY-MM-DD[ T]HH:MM[:SS]
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    const [, y, mo, d, hh = '0', mm = '0', ss = '0'] = m;
    return new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mm, +ss));
  }
  // dd/mm/yyyy[ HH:MM[:SS]]  (legacy Outlook ingest used dayfirst=True)
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    const [, d, mo, y, hh = '0', mm = '0', ss = '0'] = m;
    return new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mm, +ss));
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t);
}

// แตก CSV (เลขที่สิทธิ์/Permissions) เป็น array สะอาด
export function csv(v: unknown): string[] {
  const s = str(v);
  if (!s) return [];
  return s.split(',').map((x) => x.trim()).filter(Boolean);
}
