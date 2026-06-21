export const baht = (v: unknown): string =>
  `฿${Number(v ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const num = (v: unknown): string => Number(v ?? 0).toLocaleString('en-US');

export const thaiDate = (v: unknown): string => {
  if (!v) return '—';
  const d = new Date(v as string);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleDateString('th-TH');
};
