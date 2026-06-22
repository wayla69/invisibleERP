'use client';

import * as React from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown, Inbox } from 'lucide-react';

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

interface DataTableProps<T extends Record<string, any>> {
  rows: T[];
  columns: Column<T>[];
  loading?: boolean;
  emptyText?: string;
  dense?: boolean;
  className?: string;
  rowKey?: (row: T, i: number) => string | number;
  onRowClick?: (row: T) => void;
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
  dense,
  className,
  rowKey,
  onRowClick,
}: DataTableProps<T>) {
  const [sort, setSort] = React.useState<{ key: string; dir: 'asc' | 'desc' } | null>(null);

  const sorted = React.useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return rows;
    const out = [...rows].sort((ra, rb) => cmp(ra[sort.key], rb[sort.key]));
    return sort.dir === 'desc' ? out.reverse() : out;
  }, [rows, sort, columns]);

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
                <div className="flex flex-col items-center gap-2 text-muted-foreground">
                  <Inbox className="size-8 opacity-40" />
                  <span className="text-sm">{emptyText}</span>
                </div>
              </TableCell>
            </TableRow>
          ) : (
            sorted.map((row, i) => (
              <TableRow
                key={rowKey ? rowKey(row, i) : i}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={cn(onRowClick && 'cursor-pointer')}
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
  );
}
