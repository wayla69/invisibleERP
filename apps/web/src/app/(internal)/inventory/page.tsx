'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import Link from 'next/link';
import { CalendarClock, Hourglass, Package, Search, TriangleAlert } from 'lucide-react';
import { api } from '@/lib/api';
import { num, thaiDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

interface StockResp {
  snapshot_date: string | null;
  items: { Item_ID: string; Item_Description: string; UOM: string; AV_QTY: string; Total_Stock: string; Expiry_Date: string | null }[];
  total: number;
  low_stock_count: number;
}

const DAY_MS = 86_400_000;
const SOON_DAYS = 30;

// Expiry visual cue only (tone for the cell + the summary count). Compared against the device clock, which
// for in-store use ≈ Asia/Bangkok; this never feeds a posting, so the business-day nuance doesn't apply.
function expiryTone(v: string | null): 'destructive' | 'warning' | null {
  if (!v) return null;
  const t = new Date(v).getTime();
  if (Number.isNaN(t)) return null;
  const days = Math.floor((t - Date.now()) / DAY_MS);
  if (days < 0) return 'destructive';
  if (days <= SOON_DAYS) return 'warning';
  return null;
}

export default function InventoryPage() {
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [lowOnly, setLowOnly] = useState(false);

  // Debounce the free-text search so we don't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const q = useQuery<StockResp>({
    queryKey: ['stock', debounced, lowOnly],
    queryFn: () => api(`/api/inventory/stock?limit=200&low_only=${lowOnly}${debounced ? `&search=${encodeURIComponent(debounced)}` : ''}`),
    // Keep the previous table visible while a new filter loads — no skeleton flash on every search/toggle.
    placeholderData: keepPreviousData,
  });
  const d = q.data;
  const filtering = debounced.length > 0 || lowOnly;

  // "Expiring soon / expired" count over the loaded rows (honestly scoped to what's shown).
  const expiringSoon = useMemo(() => (d?.items ?? []).filter((it) => expiryTone(it.Expiry_Date)).length, [d]);

  return (
    <div>
      <PageHeader title="สินค้าคงคลัง" description="ระดับสต๊อกและวันหมดอายุ" />

      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="ค้นหา Item ID / ชื่อสินค้า…"
            aria-label="ค้นหาสินค้า"
            inputMode="search"
            enterKeyHint="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Button variant={lowOnly ? 'default' : 'outline'} aria-pressed={lowOnly} onClick={() => setLowOnly((v) => !v)}>
          <TriangleAlert className="size-4" /> เฉพาะสต๊อกต่ำ
        </Button>
        {q.isFetching && !q.isLoading && <span className="text-xs text-muted-foreground">กำลังอัปเดต…</span>}
      </div>

      <StateView q={q}>
        {d && (
          <div className={cn('space-y-5 transition-opacity', q.isFetching && 'opacity-60')}>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard label="Snapshot" value={d.snapshot_date ? thaiDate(d.snapshot_date) : '—'} icon={CalendarClock} hint="ข้อมูล ณ วันที่" />
              <StatCard label="รายการทั้งหมด" value={num(d.total)} icon={Package} tone="primary" />
              <StatCard label="สต๊อกต่ำ" value={num(d.low_stock_count)} icon={TriangleAlert} tone={d.low_stock_count > 0 ? 'warning' : 'success'} hint="ต้องเติมสินค้า" />
              <StatCard
                label="หมดอายุ / ใกล้หมด (≤30 วัน)"
                value={num(expiringSoon)}
                icon={Hourglass}
                tone={expiringSoon > 0 ? 'danger' : 'success'}
                hint="จากรายการที่แสดง"
              />
            </div>
            <DataTable
              rows={d.items}
              rowKey={(r) => r.Item_ID}
              emptyText={filtering ? 'ไม่พบสินค้าที่ตรงกับตัวกรอง' : 'ไม่มีข้อมูลสินค้า'}
              columns={[
                { key: 'Item_ID', label: 'Item ID', render: (r) => <Link className="font-medium text-primary hover:underline" href={`/inventory/${encodeURIComponent(r.Item_ID)}`}>{r.Item_ID}</Link> },
                { key: 'Item_Description', label: 'ชื่อสินค้า' },
                { key: 'UOM', label: 'หน่วย' },
                { key: 'AV_QTY', label: 'คงเหลือ', align: 'right', render: (r) => <span className={cn('tabular', Number(r.AV_QTY) <= 0 && 'font-semibold text-destructive')}>{num(r.AV_QTY)}</span> },
                {
                  key: 'Expiry_Date',
                  label: 'หมดอายุ',
                  render: (r) => {
                    const tone = expiryTone(r.Expiry_Date);
                    return (
                      <span className={cn(tone === 'destructive' && 'font-medium text-destructive', tone === 'warning' && 'text-warning-foreground dark:text-warning')}>
                        {r.Expiry_Date ? thaiDate(r.Expiry_Date) : '—'}
                      </span>
                    );
                  },
                },
              ]}
            />
          </div>
        )}
      </StateView>
    </div>
  );
}
