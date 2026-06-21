// Single source of truth for business-timezone date parts. All human-facing doc numbers,
// daily counters, and accounting dates derive from here so doc-day == accounting-day == period,
// regardless of the server's clock timezone.
//
// Implementation uses a fixed UTC offset (no ICU dependency, so it works under the harness's
// minimal Node ICU too). Asia/Bangkok is UTC+7 with no DST, so a fixed offset is always correct.
// Override with BUSINESS_TZ_OFFSET_MIN for other no-DST regions.

export interface BizParts { y: number; mo: number; d: number; h: number; mi: number; s: number; }

export function bizParts(d: Date = new Date()): BizParts {
  const off = Number(process.env.BUSINESS_TZ_OFFSET_MIN ?? 420); // +07:00 (Asia/Bangkok)
  const t = new Date(d.getTime() + off * 60_000);
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(), h: t.getUTCHours(), mi: t.getUTCMinutes(), s: t.getUTCSeconds() };
}

const pad = (n: number) => String(n).padStart(2, '0');
export const bizYmdCompact = (d?: Date) => { const p = bizParts(d); return `${p.y}${pad(p.mo)}${pad(p.d)}`; };                       // YYYYMMDD
export const bizYmdDash    = (d?: Date) => { const p = bizParts(d); return `${p.y}-${pad(p.mo)}-${pad(p.d)}`; };                     // YYYY-MM-DD
export const bizStamp      = (d?: Date) => { const p = bizParts(d); return `${bizYmdCompact(d)}${pad(p.h)}${pad(p.mi)}${pad(p.s)}`; }; // YYYYMMDDHHMMSS
export const bizHourMin    = (d?: Date) => { const p = bizParts(d); return `${pad(p.h)}${pad(p.mi)}`; };                              // HHMM
