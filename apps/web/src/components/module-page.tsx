'use client';

import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { Tabs, type TabDef } from '@/components/tabs';

/**
 * `ModulePage` — the standard screen shell for ERP module pages.
 *
 * It is a thin *composition* of the building blocks every page already hand-assembles (`PageHeader`, the
 * KPI grid, a toolbar row, `StateView`, the body), not a framework. Adopting it makes screens share one
 * vertical rhythm and one loading/error gate — the "every page looks the same" feel of PEAK — while staying
 * **opt-in per page**: an un-migrated page is byte-identical to before.
 *
 * Layout (top → bottom):
 *   PageHeader (title / description / actions)  — rendered only when `title` is given
 *   toolbar          — search + filters, always visible (rendered outside the data gate)
 *   ── if `tabs` ──   Tabs (optionally URL-synced via `tabUrlParam`)
 *   ── else ──        StateView gate → [ stats KPI grid ] + children
 *
 * Omit `title` to use it as a **tab/section body** (no header) — the page renders its own `PageHeader`
 * once and each tab uses `ModulePage` for just the toolbar/stats/table; in that case put the section's
 * action buttons in the `toolbar` slot.
 *
 * Data-dependent `stats`/`children` should be guarded by the caller with `data && (…)` (exactly as the
 * pages do today) so they only construct once loaded; `StateView` shows the skeleton meanwhile, and
 * `query.isFetching` dims the body during background refetches.
 */
export interface ModulePageProps {
  /** Page title. Omit to render a headerless section/tab body (see note above). */
  title?: ReactNode;
  description?: ReactNode;
  /** Primary actions (create / export buttons) shown at the top-right of the header. */
  actions?: ReactNode;
  /** Search / filter row, rendered above the body and always visible (not gated by `query`). */
  toolbar?: ReactNode;
  toolbarClassName?: string;
  /** KPI strip — pass `<StatCard/>`s; the scaffold wraps them in the standard responsive grid. */
  stats?: ReactNode;
  /** Override the KPI grid (e.g. `"xl:grid-cols-3"`) when a page has a different number of stat cards. */
  statsClassName?: string;
  /** When provided, the body is wrapped in `StateView` (skeleton while loading, alert on error). */
  query?: { isLoading: boolean; error: unknown; isFetching?: boolean };
  /** When provided, renders a `Tabs` block instead of the stats+children body. */
  tabs?: TabDef[];
  /** Makes the active tab deep-linkable via this query-string key (e.g. `"tab"` ↔ `?tab=payables`). */
  tabUrlParam?: string;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
}

export function ModulePage({
  title,
  description,
  actions,
  toolbar,
  toolbarClassName,
  stats,
  statsClassName,
  query,
  tabs,
  tabUrlParam,
  children,
  className,
  bodyClassName,
}: ModulePageProps) {
  const body = (
    <div className={cn('space-y-5 transition-opacity', query?.isFetching && 'opacity-60', bodyClassName)}>
      {stats && <div className={cn('grid gap-4 sm:grid-cols-2 xl:grid-cols-4', statsClassName)}>{stats}</div>}
      {children}
    </div>
  );

  return (
    <div className={className}>
      {title != null && <PageHeader title={title} description={description} actions={actions} />}

      {toolbar && (
        <div className={cn('mb-5 flex flex-col gap-3 sm:flex-row sm:items-center', toolbarClassName)}>{toolbar}</div>
      )}

      {tabs ? (
        <Tabs tabs={tabs} urlParam={tabUrlParam} />
      ) : query ? (
        <StateView q={query}>{body}</StateView>
      ) : (
        body
      )}
    </div>
  );
}
