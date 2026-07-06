'use client';

import * as React from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown, Inbox } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useLang } from '@/lib/i18n';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';

export interface Column<T> {
  key: string;
  label: string;
  render?: (row: T) => React.ReactNode;
  align?: 'left' | 'right' | 'center';
  sortable?: boolean;
  className?: string;
}

/** Rich empty-state content. Friendlier than a bare line of text — an icon, a title, a one-line
 *  description, and an optional call-to-action (e.g. a "Create" button or a "Clear filters" link). */
export interface EmptyState {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
}

interface DataTableProps<T extends Record<string, any>> {
  rows: T[];
  columns: Column<T>[];
  loading?: boolean;
  /** Simple empty message. Prefer `emptyState` for a guided empty view. */
  emptyText?: string;
  /** Rich empty view (icon + title + description + action). Takes precedence over `emptyText`. */
  emptyState?: EmptyState;
  dense?: boolean;
  className?: string;
  rowKey?: (row: T, i: number) => string | number;
  onRowClick?: (row: T) => void;
  // Client-side page size — caps how many rows are in the DOM at once (a 500-row catalog renders 50 nodes,
  // not 500). Set to 0 to disable paging and render everything. Default 50.
  pageSize?: number;
  /** Column key to feature as the card title on the phone-width fallback view (defaults to the first column). */
  cardTitleKey?: string;
  /** Escape hatch: opt a table out of the built-in phone-card fallback (rare — e.g. an already-hand-rolled
   *  mobile view). Defaults to on, matching the pattern used across the app (see requisitions/page.tsx). */
  mobileCards?: boolean;
}

function cmp(a: unknown, b: unknown): number {
  const an = typeof a === 'number' ? a : Number(a);
  const bn = typeof b === 'number' ? b : Number(b);
  if (!Number.isNaN(an) && !Number.isNaN(bn) && a !== '' && b !== '') return an - bn;
  return String(a ?? '').localeCompare(String(b ?? ''), 'th');
}

export function DataTable<T extends Record<string, any>>({
  rows,
  columns,
  loading,
  emptyText,
  emptyState,
  dense,
  className,
  rowKey,
  onRowClick,
  pageSize = 50,
  cardTitleKey,
  mobileCards = true,
}: DataTableProps<T>) {
  const { t } = useLang();
  const [sort, setSort] = React.useState<{ key: string; dir: 'asc' | 'desc' } | null>(null);
  const [page, setPage] = React.useState(0);

  const sorted = React.useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return rows;
    const out = [...rows].sort((ra, rb) => cmp(ra[sort.key], rb[sort.key]));
    return sort.dir === 'desc' ? out.reverse() : out;
  }, [rows, sort, columns]);

  const paginate = pageSize > 0 && sorted.length > pageSize;
  const pageCount = paginate ? Math.ceil(sorted.length / pageSize) : 1;
  const pageClamped = Math.min(page, pageCount - 1);
  const visible = paginate ? sorted.slice(pageClamped * pageSize, pageClamped * pageSize + pageSize) : sorted;
  // Reset to the first page whenever the underlying data or sort changes (avoids a stale empty page).
  React.useEffect(() => { setPage(0); }, [rows, sort]);

  function toggleSort(c: Column<T>) {
    if (c.sortable === false) return;
    setSort((prev) =>
      prev?.key === c.key
        ? prev.dir === 'asc'
          ? { key: c.key, dir: 'desc' }
          : null
        : { key: c.key, dir: 'asc' },
    );
  }

  const alignCls = (a?: string) =>
    a === 'right' ? 'text-right' : a === 'center' ? 'text-center' : 'text-left';

  // Phone-width fallback: a real <table> squeezed under a breakpoint forces every column into a cramped,
  // tall sliver and the header just scrolls away with the rows. Below `sm` we stack each row as its own
  // card instead — title column leads, the rest render as label/value lines — mirroring the hand-rolled
  // pattern from requisitions/page.tsx, but generic here so every consumer gets it for free.
  const titleCol = (cardTitleKey ? columns.find((c) => c.key === cardTitleKey) : undefined) ?? columns[0];
  const restCols = columns.filter((c) => c.key !== titleCol?.key);

  const cardBody = loading ? (
    <div className="space-y-2 p-3">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="rounded-lg border p-3">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="mt-2 h-3 w-1/3" />
        </div>
      ))}
    </div>
  ) : sorted.length === 0 ? (
    <div className="px-4 py-12 text-center">
      {emptyState ? (
        (() => {
          const Icon = emptyState.icon ?? Inbox;
          return (
            <div className="mx-auto flex max-w-sm flex-col items-center gap-2">
              <div className="grid size-12 place-items-center rounded-full bg-muted text-muted-foreground">
                <Icon className="size-6" />
              </div>
              <span className="text-sm font-medium text-foreground">{emptyState.title}</span>
              {emptyState.description && (
                <p className="text-sm text-muted-foreground">{emptyState.description}</p>
              )}
              {emptyState.action && <div className="mt-2">{emptyState.action}</div>}
            </div>
          );
        })()
      ) : (
        <div className="flex flex-col items-center gap-2 text-muted-foreground">
          <Inbox className="size-8 opacity-40" />
          <span className="text-sm">{emptyText ?? t('mx.dtbl_empty')}</span>
        </div>
      )}
    </div>
  ) : (
    <div className="space-y-2 p-2">
      {visible.map((row, i) => (
        <div
          key={rowKey ? rowKey(row, i) : pageClamped * pageSize + i}
          onClick={onRowClick ? () => onRowClick(row) : undefined}
          role={onRowClick ? 'button' : undefined}
          tabIndex={onRowClick ? 0 : undefined}
          onKeyDown={
            onRowClick
              ? (e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onRowClick(row);
                  }
                }
              : undefined
          }
          className={cn(
            'rounded-lg border bg-card p-3 text-sm',
            onRowClick &&
              'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
          )}
        >
          {titleCol && (
            <div className="font-medium">
              {titleCol.render ? titleCol.render(row) : String(row[titleCol.key] ?? '—')}
            </div>
          )}
          {restCols.length > 0 && (
            <dl className="mt-1.5 space-y-1 border-t pt-1.5">
              {restCols.map((c) => (
                <div key={c.key} className="flex items-baseline justify-between gap-3">
                  <dt className="shrink-0 text-xs text-muted-foreground">{c.label}</dt>
                  <dd className={cn('min-w-0', alignCls(c.align))}>
                    {c.render ? c.render(row) : String(row[c.key] ?? '—')}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      ))}
    </div>
  );

  return (
    <div className={cn('overflow-hidden rounded-xl border bg-card', className)}>
      {mobileCards && <div className="sm:hidden">{cardBody}</div>}
      <div className={cn(mobileCards && 'hidden sm:block')}>
        <Table>
        <TableHeader className="bg-muted/40">
          <TableRow className="hover:bg-transparent">
            {columns.map((c) => {
              const active = sort?.key === c.key;
              const sortable = c.sortable !== false;
              return (
                <TableHead
                  key={c.key}
                  className={cn(alignCls(c.align), sortable && 'cursor-pointer select-none', c.className)}
                  onClick={() => sortable && toggleSort(c)}
                >
                  <span className={cn('inline-flex items-center gap-1', c.align === 'right' && 'flex-row-reverse')}>
                    {c.label}
                    {sortable &&
                      (active ? (
                        sort!.dir === 'asc' ? (
                          <ArrowUp className="size-3.5 text-foreground" />
                        ) : (
                          <ArrowDown className="size-3.5 text-foreground" />
                        )
                      ) : (
                        <ChevronsUpDown className="size-3.5 opacity-40" />
                      ))}
                  </span>
                </TableHead>
              );
            })}
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? (
            Array.from({ length: 5 }).map((_, i) => (
              <TableRow key={i} className="hover:bg-transparent">
                {columns.map((c) => (
                  <TableCell key={c.key} className={cn(dense && 'py-2')}>
                    <Skeleton className="h-4 w-full max-w-[120px]" />
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : sorted.length === 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={columns.length} className="py-12 text-center">
                {emptyState ? (
                  (() => {
                    const Icon = emptyState.icon ?? Inbox;
                    return (
                      <div className="mx-auto flex max-w-sm flex-col items-center gap-2">
                        <div className="grid size-12 place-items-center rounded-full bg-muted text-muted-foreground">
                          <Icon className="size-6" />
                        </div>
                        <span className="text-sm font-medium text-foreground">{emptyState.title}</span>
                        {emptyState.description && (
                          <p className="text-sm text-muted-foreground">{emptyState.description}</p>
                        )}
                        {emptyState.action && <div className="mt-2">{emptyState.action}</div>}
                      </div>
                    );
                  })()
                ) : (
                  <div className="flex flex-col items-center gap-2 text-muted-foreground">
                    <Inbox className="size-8 opacity-40" />
                    <span className="text-sm">{emptyText ?? t('mx.dtbl_empty')}</span>
                  </div>
                )}
              </TableCell>
            </TableRow>
          ) : (
            visible.map((row, i) => (
              <TableRow
                key={rowKey ? rowKey(row, i) : pageClamped * pageSize + i}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                // Clickable rows are keyboard-operable (Enter/Space) and focus-ringed for accessibility.
                role={onRowClick ? 'button' : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                onKeyDown={
                  onRowClick
                    ? (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onRowClick(row);
                        }
                      }
                    : undefined
                }
                className={cn(
                  onRowClick &&
                    'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                )}
              >
                {columns.map((c) => (
                  <TableCell key={c.key} className={cn(alignCls(c.align), dense && 'py-2', c.className)}>
                    {c.render ? c.render(row) : String(row[c.key] ?? '—')}
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
      </div>
      {paginate && !loading && (
        <div className="flex items-center justify-between gap-2 border-t px-3 py-2 text-sm text-muted-foreground">
          <span className="tabular">
            {t('mx.dtbl_range', { from: pageClamped * pageSize + 1, to: Math.min((pageClamped + 1) * pageSize, sorted.length), total: sorted.length })}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="rounded-md border px-2 py-1 text-xs disabled:opacity-40 hover:bg-accent"
              disabled={pageClamped <= 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              {t('mx.dtbl_prev')}
            </button>
            <span className="tabular px-1 text-xs">{pageClamped + 1}/{pageCount}</span>
            <button
              type="button"
              className="rounded-md border px-2 py-1 text-xs disabled:opacity-40 hover:bg-accent"
              disabled={pageClamped >= pageCount - 1}
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            >
              {t('mx.dtbl_next')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
