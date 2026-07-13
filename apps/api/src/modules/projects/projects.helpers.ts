// Pure helpers for the projects module (docs/38 §3 projects decomposition, extraction PR-1 — mirrors the
// bi pilot's report-registry cut: module-level consts/functions moved VERBATIM, no DI/constructor change,
// so the goldenmaster positional-construction canary `new ProjectsService(db, ledger)` is provably
// unaffected).
export const r2 = (x: unknown) => Math.round((Number(x) || 0) * 100) / 100;
// Default value→FTE rate (PMO-5): the revenue one full-time-equivalent delivers per month. Used to convert
// the probability-weighted pipeline VALUE into projected resourcing DEMAND (FTE). Overridable per request.
export const DEFAULT_REV_PER_FTE_MONTH = 200000;
export const r4 = (x: unknown) => Math.round((Number(x) || 0) * 10000) / 10000;
export const clampPct = (x: unknown) => Math.max(0, Math.min(100, r2(x)));
export const depsCsv = (ids?: number[]) => (ids && ids.length ? ids.map((i) => Number(i)).filter((i) => Number.isFinite(i)).join(',') : null);
// People CSV (RACI lists) — trim, drop blanks/dupes; null when empty so an omitted field clears nothing.
export const peopleCsv = (xs?: string[]) => {
  if (xs == null) return undefined; // not provided → leave column untouched
  const u = [...new Set(xs.map((x) => String(x).trim()).filter(Boolean))];
  return u.length ? u.join(',') : null;
};
export const csvToList = (s: unknown) => (s ? String(s).split(',').map((x) => x.trim()).filter(Boolean) : []);

// Risk scoring (1..25): a risk is probability × impact; an issue has already occurred (probability = 5/certain)
// so it scores 5 × impact. RAG follows the score band — red ≥ 12 (HIGH), amber ≥ 6, else green.
export const clamp15 = (x: unknown) => Math.max(1, Math.min(5, Math.round(Number(x) || 1)));
export const riskScore = (kind: string, prob: number | null, impact: number) => (kind === 'issue' ? 5 : (prob ?? 1)) * impact;
export const ragFor = (score: number) => (score >= 12 ? 'red' : score >= 6 ? 'amber' : 'green');

// Add whole days to a yyyy-mm-dd date string (UTC date arithmetic — date-only, no TZ drift).
export const addDays = (ymdStr: string, days: number) => {
  const d = new Date(`${ymdStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + (Number(days) || 0));
  return d.toISOString().slice(0, 10);
};

// Working-calendar-aware duration (PPM-B1, PROJ-21): inclusive working-day count between two yyyy-mm-dd
// dates, skipping the given non-working weekdays (0=Sun..6=Sat) and explicit exception dates. Only called
// when a tenant's project_calendars row has enabled=true — the plain calendar-day count (unchanged) is used
// otherwise, so this never regresses a tenant that hasn't opted in.
export const workingDaysBetween = (startYmd: string, endYmd: string, nonWorkingWeekdays: number[], exceptions: Set<string>) => {
  const start = new Date(`${startYmd}T00:00:00Z`);
  const end = new Date(`${endYmd}T00:00:00Z`);
  let count = 0;
  for (const d = new Date(start); d.getTime() <= end.getTime(); d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    if (!nonWorkingWeekdays.includes(d.getUTCDay()) && !exceptions.has(iso)) count++;
  }
  return count;
};
