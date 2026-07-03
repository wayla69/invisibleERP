'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import type { LucideIcon } from 'lucide-react';
import { AlarmClock, ArrowRight, BellRing, HandCoins, Package } from 'lucide-react';

import { api } from '@/lib/api';
import { num } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { StatCard } from '@/components/stat-card';

type Tone = 'default' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

/**
 * "สิ่งที่ต้องทำวันนี้" — a PEAK-Board-style action launcher above the dashboard KPIs. Each card is a live
 * count that links into the screen where the work gets done, turning the landing page from a passive
 * metrics board into a task launcher.
 *
 * The three approval/collection cards run their own permission-gated queries with `retry:false`, so a user
 * without the right (HTTP 403 → `data` stays undefined) simply doesn't see that card — no extra perm logic,
 * mirroring the finance page's self-hiding `pendingPay` queue. The low-stock card is fed from the dashboard
 * payload the page already fetched, so it adds no extra request.
 */
function ActionCard({
  label,
  value,
  icon,
  tone,
  hint,
  href,
}: {
  label: string;
  value: ReactNode;
  icon: LucideIcon;
  tone: Tone;
  hint: string;
  href: string;
}) {
  return (
    <Link href={href} className="group block rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <StatCard
        label={label}
        value={value}
        icon={icon}
        tone={tone}
        hint={
          <span className="inline-flex items-center gap-1 group-hover:text-foreground">
            {hint} <ArrowRight className="size-3" />
          </span>
        }
        className="transition-colors group-hover:border-primary/40 group-hover:bg-muted/40"
      />
    </Link>
  );
}

/** `lowStock` comes from the dashboard's existing `/api/dashboard` payload (`low_stock_count`). */
export function TodayActions({ lowStock }: { lowStock?: number }) {
  const { t } = useLang();
  const approvals = useQuery<{ items: { overdue: boolean }[] }>({
    queryKey: ['ta-approvals'],
    queryFn: () => api('/api/workflow/my-approvals'),
    retry: false,
  });
  const apPending = useQuery<{ payments: unknown[] }>({
    queryKey: ['ta-ap-pending'],
    queryFn: () => api('/api/finance/ap/payments/pending'),
    retry: false,
  });
  const arOverdue = useQuery<{ rows: unknown[] }>({
    queryKey: ['ta-ar-overdue'],
    queryFn: () => api('/api/finance/ar/collections?overdue_only=1'),
    retry: false,
  });

  const cards: ReactNode[] = [];

  if (approvals.data) {
    const items = approvals.data.items ?? [];
    const overdue = items.filter((i) => i.overdue).length;
    cards.push(
      <ActionCard
        key="appr"
        href="/workflow"
        icon={AlarmClock}
        label={t('today.approvals')}
        value={num(items.length)}
        tone={overdue > 0 ? 'danger' : items.length > 0 ? 'warning' : 'success'}
        hint={overdue > 0 ? t('today.n_overdue', { n: num(overdue) }) : items.length > 0 ? t('today.pending') : t('today.none')}
      />,
    );
  }
  if (apPending.data) {
    const n = (apPending.data.payments ?? []).length;
    cards.push(
      <ActionCard
        key="appay"
        href="/finance?tab=payables"
        icon={HandCoins}
        label={t('today.ap_pending')}
        value={num(n)}
        tone={n > 0 ? 'warning' : 'success'}
        hint={n > 0 ? t('today.approve_pay') : t('today.none')}
      />,
    );
  }
  if (arOverdue.data) {
    const n = (arOverdue.data.rows ?? []).length;
    cards.push(
      <ActionCard
        key="arov"
        href="/finance?tab=receivables"
        icon={BellRing}
        label={t('today.ar_overdue')}
        value={num(n)}
        tone={n > 0 ? 'danger' : 'success'}
        hint={n > 0 ? t('today.follow_up') : t('today.none')}
      />,
    );
  }
  if (typeof lowStock === 'number') {
    cards.push(
      <ActionCard
        key="low"
        href="/inventory"
        icon={Package}
        label={t('today.low_stock')}
        value={num(lowStock)}
        tone={lowStock > 0 ? 'warning' : 'success'}
        hint={lowStock > 0 ? t('today.need_restock') : t('today.enough')}
      />,
    );
  }

  if (cards.length === 0) return null;

  return (
    <div className="mb-6">
      <h3 className="mb-3 text-sm font-semibold text-muted-foreground">{t('today.title')}</h3>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{cards}</div>
    </div>
  );
}
