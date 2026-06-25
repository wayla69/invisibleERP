'use client';

import * as React from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown, Inbox } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';
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
  emptyText = 'ไม่มีข้อมูล',
  emptyState,
  dense,
  className,
  rowKey,
  onRowClick,
  pageSize = 50,
}: DataTableProps<T>) {
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

  return (
    <div className={cn('overflow-hidden rounded-xl border bg-card', className)}>
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
                    <span className="text-sm">{emptyText}</span>
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
      {paginate && !loading && (
        <div className="flex items-center justify-between gap-2 border-t px-3 py-2 text-sm text-muted-foreground">
          <span className="tabular">
            {pageClamped * pageSize + 1}–{Math.min((pageClamped + 1) * pageSize, sorted.length)} จาก {sorted.length}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="rounded-md border px-2 py-1 text-xs disabled:opacity-40 hover:bg-accent"
              disabled={pageClamped <= 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              ก่อนหน้า
            </button>
            <span className="tabular px-1 text-xs">{pageClamped + 1}/{pageCount}</span>
            <button
              type="button"
              className="rounded-md border px-2 py-1 text-xs disabled:opacity-40 hover:bg-accent"
              disabled={pageClamped >= pageCount - 1}
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            >
              ถัดไป
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
