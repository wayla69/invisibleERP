export const baht = (v: unknown): string =>
  `฿${Number(v ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const num = (v: unknown): string => Number(v ?? 0).toLocaleString('en-US');

export const thaiDate = (v: unknown): string => {
  if (!v) return '—';
  const d = new Date(v as string);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleDateString('th-TH');
};

// Percent with a fixed digit count (default 1) — replaces the ad-hoc `x.toFixed(1) + '%'` scattered in
// pages (docs/39 batch 0). Accepts the value ALREADY in percent units (12.34 → '12.3%').
export const pct = (v: unknown, digits = 1): string => `${Number(v ?? 0).toFixed(digits)}%`;
