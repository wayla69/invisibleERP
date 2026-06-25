'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ClipboardList, Coins, Hourglass, Search } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num, thaiDate } from '@/lib/format';
import { ModulePage } from '@/components/module-page';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { statusVariant } from '@/components/ui';

interface PO { PO_No: string; PO_Date: string; Supplier_Name?: string; Total_Amount: number; Status: string }

export default function PurchaseOrdersPage() {
  const q = useQuery<{ purchase_orders: PO[] }>({ queryKey: ['pos'], queryFn: () => api('/api/inventory/purchase-orders?limit=50') });
  const rows = q.data?.purchase_orders ?? [];

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string | null>(null);

  const statuses = useMemo(() => Array.from(new Set(rows.map((r) => r.Status).filter(Boolean))), [rows]);
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (statusFilter && r.Status !== statusFilter) return false;
      if (!term) return true;
      return (r.PO_No ?? '').toLowerCase().includes(term) || (r.Supplier_Name ?? '').toLowerCase().includes(term);
    });
  }, [rows, search, statusFilter]);

  // Summary over the loaded window (honestly labelled — recent POs shown, not an all-time total).
  const summary = useMemo(() => {
    const total = rows.reduce((a, r) => a + Number(r.Total_Amount ?? 0), 0);
    const open = rows.filter((r) => statusVariant(r.Status) !== 'success').length;
    return { count: rows.length, total, open };
  }, [rows]);

  return (
    <ModulePage
      title="ใบสั่งซื้อ (PO)"
      description="รายการใบสั่งซื้อและสถานะ"
      query={q}
      toolbarClassName="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
      toolbar={
        <>
          <div className="relative w-full sm:max-w-xs">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="ค้นหาเลขที่ PO หรือผู้ขาย…"
              className="pl-9"
              aria-label="ค้นหาใบสั่งซื้อ"
              inputMode="search"
              enterKeyHint="search"
            />
          </div>
          {statuses.length > 1 && (
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="กรองตามสถานะ">
              <Button variant={statusFilter === null ? 'secondary' : 'ghost'} size="sm" onClick={() => setStatusFilter(null)}>
                ทั้งหมด
              </Button>
              {statuses.map((s) => (
                <Button
                  key={s}
                  variant={statusFilter === s ? 'secondary' : 'ghost'}
                  size="sm"
                  aria-pressed={statusFilter === s}
                  onClick={() => setStatusFilter((c) => (c === s ? null : s))}
                >
                  {s}
                </Button>
              ))}
            </div>
          )}
        </>
      }
      statsClassName="sm:grid-cols-3 xl:grid-cols-3"
      stats={
        q.data && (
          <>
            <StatCard label="ใบสั่งซื้อที่แสดง" value={num(summary.count)} icon={ClipboardList} tone="primary" hint="50 รายการล่าสุด" />
            <StatCard label="มูลค่ารวม" value={baht(summary.total)} icon={Coins} tone="default" hint="จากรายการที่แสดง" />
            <StatCard
              label="รอดำเนินการ / อนุมัติ"
              value={num(summary.open)}
              icon={Hourglass}
              tone={summary.open > 0 ? 'warning' : 'success'}
              hint="ยังไม่เสร็จสมบูรณ์"
            />
          </>
        )
      }
    >
      {q.data && (
        <DataTable
          rows={filtered}
          rowKey={(r) => r.PO_No}
          emptyText={search || statusFilter ? 'ไม่พบใบสั่งซื้อที่ตรงกับตัวกรอง' : 'ยังไม่มีใบสั่งซื้อ'}
          columns={[
            { key: 'PO_No', label: 'PO' },
            { key: 'PO_Date', label: 'วันที่', render: (r) => thaiDate(r.PO_Date) },
            { key: 'Supplier_Name', label: 'ผู้ขาย', render: (r) => r.Supplier_Name || '—' },
            { key: 'Total_Amount', label: 'ยอด', align: 'right', render: (r) => <span className="tabular">{baht(r.Total_Amount)}</span> },
            { key: 'Status', label: 'สถานะ', render: (r) => <Badge variant={statusVariant(r.Status)}>{r.Status}</Badge> },
          ]}
        />
      )}
    </ModulePage>
  );
}
