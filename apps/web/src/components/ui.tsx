'use client';

/**
 * Compatibility layer — preserves the original ui.tsx API (Card, Kpi, Badge,
 * StateView, DataTable) so existing pages keep working, but renders the new
 * shadcn/Tailwind design. New pages should prefer the dedicated components
 * (StatCard, DataTable, Badge from ui/badge, etc.) directly.
 */
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';
import { Card as ShadcnCard } from '@/components/ui/card';
import { Badge as ShadcnBadge } from '@/components/ui/badge';
import { StatCard } from '@/components/stat-card';

export { StateView } from '@/components/state-view';
export { DataTable } from '@/components/data-table';

export function Card({ children, style, className }: { children: ReactNode; style?: React.CSSProperties; className?: string }) {
  return (
    <ShadcnCard style={style} className={cn('gap-4 p-5', className)}>
      {children}
    </ShadcnCard>
  );
}

/** Legacy accent strings → semantic tone. */
function accentTone(accent?: string): 'default' | 'primary' | 'danger' {
  if (!accent) return 'default';
  if (accent.includes('ruby') || accent.includes('red')) return 'danger';
  return 'primary';
}

export function Kpi({ label, value, accent }: { label: string; value: ReactNode; accent?: string }) {
  return <StatCard label={label} value={value} tone={accentTone(accent)} className="min-w-[160px]" />;
}

/** Map a status string to a Badge variant. Shared brand-wide. */
export function statusVariant(
  value: string,
): 'default' | 'secondary' | 'destructive' | 'success' | 'warning' | 'info' | 'muted' {
  const v = (value || '').toLowerCase();
  if (['completed', 'paid', 'closed', 'received', 'approved', 'active', 'done', 'success', 'resolved'].some((s) => v.includes(s)))
    return 'success';
  if (['pending', 'partial', 'processing…', 'hold', 'waiting', 'sent', 'draft pending'].some((s) => v.includes(s)))
    return 'warning';
  if (['unpaid', 'claimed', 'cancelled', 'canceled', 'rejected', 'failed', 'overdue', 'breach', 'error'].some((s) => v.includes(s)))
    return 'destructive';
  if (['open', 'processing', 'shipped', 'new', 'in progress', 'submitted'].some((s) => v.includes(s))) return 'info';
  if (['draft', 'closed period', 'inactive', 'archived'].some((s) => v.includes(s))) return 'muted';
  return 'secondary';
}

export function Badge({ value }: { value: string }) {
  return <ShadcnBadge variant={statusVariant(value)}>{value}</ShadcnBadge>;
}
