'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { api } from '@/lib/api';
import { Kpi, DataTable, StateView } from '@/components/ui';
import { num, thaiDate } from '@/lib/format';

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
      <h1 style={{ marginTop: 0 }}>📦 สต๊อกสินค้า</h1>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 }}>
        <input className="input" style={{ maxWidth: 280 }} placeholder="ค้นหา Item ID / ชื่อ" value={search} onChange={(e) => setSearch(e.target.value)} />
        <label className="label" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} /> เฉพาะสต๊อกต่ำ
        </label>
      </div>
      <StateView q={q}>
        {d && (
          <>
            <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
              <Kpi label="Snapshot" value={d.snapshot_date ? thaiDate(d.snapshot_date) : '—'} />
              <Kpi label="รายการ" value={num(d.total)} />
              <Kpi label="สต๊อกต่ำ" value={num(d.low_stock_count)} accent="var(--ruby)" />
            </div>
            <DataTable
              rows={d.items}
              columns={[
                { key: 'Item_ID', label: 'Item ID', render: (r) => <Link href={`/inventory/${encodeURIComponent(r.Item_ID)}`}>{r.Item_ID}</Link> },
                { key: 'Item_Description', label: 'ชื่อสินค้า' },
                { key: 'UOM', label: 'หน่วย' },
                { key: 'AV_QTY', label: 'คงเหลือ', render: (r) => <span style={{ color: Number(r.AV_QTY) <= 0 ? 'var(--ruby)' : undefined }}>{num(r.AV_QTY)}</span> },
                { key: 'Expiry_Date', label: 'หมดอายุ', render: (r) => (r.Expiry_Date ? thaiDate(r.Expiry_Date) : '—') },
              ]}
            />
          </>
        )}
      </StateView>
    </div>
  );
}
