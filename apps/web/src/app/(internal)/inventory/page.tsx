'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { CalendarClock, Package, TriangleAlert } from 'lucide-react';
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

export default function InventoryPage() {
  const [search, setSearch] = useState('');
  const [lowOnly, setLowOnly] = useState(false);
  const q = useQuery<StockResp>({
    queryKey: ['stock', search, lowOnly],
    queryFn: () => api(`/api/inventory/stock?limit=200&low_only=${lowOnly}${search ? `&search=${encodeURIComponent(search)}` : ''}`),
  });
  const d = q.data;
  return (
    <div>
      <PageHeader title="สินค้าคงคลัง" description="ระดับสต๊อกและวันหมดอายุ" />

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Input
          className="max-w-xs"
          placeholder="ค้นหา Item ID / ชื่อ"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Button
          variant={lowOnly ? 'default' : 'outline'}
          onClick={() => setLowOnly((v) => !v)}
        >
          <TriangleAlert className="size-4" /> เฉพาะสต๊อกต่ำ
        </Button>
      </div>

      <StateView q={q}>
        {d && (
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-3">
              <StatCard label="Snapshot" value={d.snapshot_date ? thaiDate(d.snapshot_date) : '—'} icon={CalendarClock} />
              <StatCard label="รายการทั้งหมด" value={num(d.total)} icon={Package} tone="primary" />
              <StatCard label="สต๊อกต่ำ" value={num(d.low_stock_count)} icon={TriangleAlert} tone={d.low_stock_count > 0 ? 'warning' : 'success'} />
            </div>
            <DataTable
              rows={d.items}
              columns={[
                { key: 'Item_ID', label: 'Item ID', render: (r) => <Link className="font-medium text-primary hover:underline" href={`/inventory/${encodeURIComponent(r.Item_ID)}`}>{r.Item_ID}</Link> },
                { key: 'Item_Description', label: 'ชื่อสินค้า' },
                { key: 'UOM', label: 'หน่วย' },
                { key: 'AV_QTY', label: 'คงเหลือ', align: 'right', render: (r) => <span className={cn('tabular', Number(r.AV_QTY) <= 0 && 'font-semibold text-destructive')}>{num(r.AV_QTY)}</span> },
                { key: 'Expiry_Date', label: 'หมดอายุ', render: (r) => (r.Expiry_Date ? thaiDate(r.Expiry_Date) : '—') },
              ]}
            />
          </div>
        )}
      </StateView>
    </div>
  );
}
