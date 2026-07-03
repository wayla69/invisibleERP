// Pure presentational (no hooks/state/browser APIs) — deliberately NOT 'use client' (same rationale as
// page-header.tsx): server pages can render it on the server; client pages that import it still bundle
// it client-side. Keeps the RSC ratchet honest.
import type { ReactNode } from 'react';
import { TrendingDown, TrendingUp } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Card } from '@/components/ui/card';

type Tone = 'default' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

const toneText: Record<Tone, string> = {
  default: 'text-foreground',
  primary: 'text-primary',
  success: 'text-success',
  warning: 'text-warning-foreground dark:text-warning',
  danger: 'text-destructive',
  info: 'text-info',
};

const toneIconBg: Record<Tone, string> = {
  default: 'bg-muted text-muted-foreground',
  primary: 'bg-primary/10 text-primary',
  success: 'bg-success/15 text-success',
  warning: 'bg-warning/20 text-warning-foreground dark:text-warning',
  danger: 'bg-destructive/10 text-destructive',
  info: 'bg-info/15 text-info',
};

export function StatCard({
  label,
  value,
  icon: Icon,
  tone = 'default',
  hint,
  trend,
  className,
}: {
  label: string;
  value: ReactNode;
  icon?: LucideIcon;
  tone?: Tone;
  hint?: ReactNode;
  trend?: { value: string; direction: 'up' | 'down' };
  className?: string;
}) {
  return (
    <Card className={cn('gap-0 p-5', className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-muted-foreground">{label}</p>
          <p className={cn('mt-2 text-2xl font-semibold tracking-tight tabular', toneText[tone])}>{value}</p>
        </div>
        {Icon && (
          <div className={cn('flex size-10 shrink-0 items-center justify-center rounded-lg', toneIconBg[tone])}>
            <Icon className="size-5" />
          </div>
        )}
      </div>
      {(hint || trend) && (
        <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
          {trend && (
            <span
              className={cn(
                'inline-flex items-center gap-1 font-medium',
                trend.direction === 'up' ? 'text-success' : 'text-destructive',
              )}
            >
              {trend.direction === 'up' ? (
                <TrendingUp className="size-3.5" />
              ) : (
                <TrendingDown className="size-3.5" />
              )}
              {trend.value}
            </span>
          )}
          {hint && <span className="truncate">{hint}</span>}
        </div>
      )}
    </Card>
  );
}
