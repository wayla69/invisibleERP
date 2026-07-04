'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Banknote, Hourglass, Plus, Receipt, SearchX, TrendingUp } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num, thaiDate } from '@/lib/format';
import { readQueryParam } from '@/lib/url';
import { PageHeader } from '@/components/page-header';
import { SearchInput } from '@/components/search-input';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { statusVariant } from '@/components/ui';

interface Order {
  Sale_No: string;
  Sale_Date: string;
  Customer_Name?: string;
  Total: number;
  Payment_Method?: string;
  Status: string;
}

export default function PosPage() {
  const q = useQuery<{ orders: Order[] }>({ queryKey: ['orders'], queryFn: () => api('/api/pos/orders?limit=50') });
  const orders = q.data?.orders ?? [];

  const [search, setSearch] = useState(() => readQueryParam('q')); // seed from a ⌘K spotlight deep-link
  const [statusFilter, setStatusFilter] = useState<string | null>(null);

  // Distinct statuses present in the loaded window — drives the quick-filter chips.
  const statuses = useMemo(() => Array.from(new Set(orders.map((o) => o.Status).filter(Boolean))), [orders]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return orders.filter((o) => {
      if (statusFilter && o.Status !== statusFilter) return false;
      if (!term) return true;
      return (o.Sale_No ?? '').toLowerCase().includes(term) || (o.Customer_Name ?? '').toLowerCase().includes(term);
    });
  }, [orders, search, statusFilter]);

  // Summary over the loaded window. Labelled honestly ("ที่แสดง") — it reflects the recent orders on this
  // page, not an all-time aggregate (that lives on the dashboard, which queries server-side totals).
  const summary = useMemo(() => {
    const total = orders.reduce((a, o) => a + Number(o.Total ?? 0), 0);
    const open = orders.filter((o) => statusVariant(o.Status) !== 'success').length;
    return { count: orders.length, total, avg: orders.length ? total / orders.length : 0, open };
  }, [orders]);

  return (
    <div>
      <PageHeader
        title="ออเดอร์"
        description="รายการขายและสถานะการชำระเงิน"
        actions={
          <Button asChild>
            <Link href="/pos/register">
              <Plus className="size-4" /> เปิดหน้าขาย
            </Link>
          </Button>
        }
      />
      <StateView q={q}>
        {q.data && (
          <div className="space-y-6">
            {/* Summary band — derived from the recent orders shown on this page */}
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard label="ออเดอร์ที่แสดง" value={num(summary.count)} icon={Receipt} tone="primary" hint="50 รายการล่าสุด" />
              <StatCard label="ยอดขายรวม" value={baht(summary.total)} icon={Banknote} tone="default" hint="จากออเดอร์ที่แสดง" />
              <StatCard label="ยอดเฉลี่ย/ออเดอร์" value={baht(summary.avg)} icon={TrendingUp} tone="info" />
              <StatCard
                label="รอดำเนินการ/ค้างชำระ"
                value={num(summary.open)}
                icon={Hourglass}
                tone={summary.open > 0 ? 'warning' : 'success'}
                hint="ยังไม่เสร็จสมบูรณ์"
              />
            </div>

            {/* Toolbar: free-text search + status quick-filter chips (client-side) */}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <SearchInput
                value={search}
                onChange={setSearch}
                placeholder="ค้นหาเลขที่ออเดอร์ หรือลูกค้า…"
                ariaLabel="ค้นหาออเดอร์"
              />
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
                      onClick={() => setStatusFilter((cur) => (cur === s ? null : s))}
                    >
                      {s}
                    </Button>
                  ))}
                </div>
              )}
            </div>

            <DataTable
              rows={filtered}
              rowKey={(r) => r.Sale_No}
              emptyState={
                search || statusFilter
                  ? {
                      icon: SearchX,
                      title: 'ไม่พบออเดอร์ที่ตรงกับตัวกรอง',
                      description: 'ลองปรับคำค้นหา หรือล้างตัวกรองเพื่อดูทั้งหมด',
                      action: (
                        <Button variant="outline" size="sm" onClick={() => { setSearch(''); setStatusFilter(null); }}>
                          ล้างตัวกรอง
                        </Button>
                      ),
                    }
                  : {
                      icon: Receipt,
                      title: 'ยังไม่มีออเดอร์',
                      description: 'สร้างออเดอร์แรกเพื่อเริ่มบันทึกการขาย',
                      action: (
                        <Button asChild size="sm">
                          <Link href="/pos/new">
                            <Plus className="size-4" /> สร้างออเดอร์
                          </Link>
                        </Button>
                      ),
                    }
              }
              columns={[
                { key: 'Sale_No', label: 'เลขที่' },
                { key: 'Sale_Date', label: 'วันที่', render: (r) => thaiDate(r.Sale_Date) },
                { key: 'Customer_Name', label: 'ลูกค้า', render: (r) => r.Customer_Name || '—' },
                { key: 'Total', label: 'ยอด', align: 'right', render: (r) => <span className="tabular">{baht(r.Total)}</span> },
                { key: 'Payment_Method', label: 'ชำระ', render: (r) => r.Payment_Method || '—' },
                { key: 'Status', label: 'สถานะ', render: (r) => <Badge variant={statusVariant(r.Status)}>{r.Status}</Badge> },
              ]}
            />
          </div>
        )}
      </StateView>
    </div>
  );
}
