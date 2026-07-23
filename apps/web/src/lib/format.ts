export const baht = (v: unknown): string =>
  `฿${Number(v ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// docs/61 marketing family — currency WITHOUT the ฿ sign (the marketing screens render "48,000 THB" per the
// approved Marketing Studio style; ERP finance pages keep baht()). Whole numbers — marketing KPIs, not GL.
export const thb = (v: unknown): string =>
  `${Number(v ?? 0).toLocaleString('en-US', { maximumFractionDigits: 0 })} THB`;
export const compactThb = (v: unknown): string => {
  const n = Number(v ?? 0);
  return n >= 1e6 ? `${(n / 1e6).toFixed(2)}M THB` : n >= 1e3 ? `${Math.round(n / 1e3)}K THB` : `${Math.round(n)} THB`;
};

export const num = (v: unknown, digits?: number): string =>
  Number(v ?? 0).toLocaleString('en-US', digits != null ? { minimumFractionDigits: digits, maximumFractionDigits: digits } : undefined);

export const thaiDate = (v: unknown): string => {
  if (!v) return '—';
  const d = new Date(v as string);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleDateString('th-TH');
};

// Percent, trailing zeros dropped (the dominant page-local semantics: 12 → '12%', 12.34 → '12.3%').
// Accepts the value ALREADY in percent units. `digits` = maximum fraction digits (default 1).
export const pct = (v: unknown, digits = 1): string =>
  `${Number(v ?? 0).toLocaleString('en-US', { maximumFractionDigits: digits })}%`;

// Thai date+TIME (for audit/log timestamps — thaiDate() is date-only and would drop the time).
export const thaiDateTime = (v: unknown): string => {
  if (!v) return '—';
  const d = new Date(v as string);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString('th-TH');
};
