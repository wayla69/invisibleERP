'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Kpi, DataTable, Badge, StateView } from '@/components/ui';
import { baht, num, thaiDate } from '@/lib/format';

interface Dash {
  today: { sales: number; orders: number };
  month: { sales: number; orders: number };
  low_stock_count: number;
  outstanding_ap: number;
  top_items_today: { Item_Description: string; qty: number; revenue: number }[];
  recent_orders: { Sale_No: string; Sale_Date: string; Total: number; Status: string; Payment_Method: string }[];
}

export default function DashboardPage() {
  const q = useQuery<Dash>({ queryKey: ['dashboard'], queryFn: () => api('/api/dashboard') });
  const d = q.data;
  return (
    <div>
      <h1 style={{ marginTop: 0 }}>Dashboard</h1>
      <StateView q={q}>
        {d && (
          <>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
              <Kpi label="ยอดขายวันนี้" value={baht(d.today.sales)} accent="var(--navy)" />
              <Kpi label="ออเดอร์วันนี้" value={num(d.today.orders)} />
              <Kpi label="ยอดขายเดือนนี้" value={baht(d.month.sales)} />
              <Kpi label="สต๊อกต่ำ (≤0)" value={num(d.low_stock_count)} accent="var(--ruby)" />
              <Kpi label="เจ้าหนี้คงค้าง (AP)" value={baht(d.outstanding_ap)} accent="var(--ruby)" />
            </div>
            <h3>สินค้าขายดีวันนี้</h3>
            <DataTable
              rows={d.top_items_today}
              columns={[
                { key: 'Item_Description', label: 'สินค้า' },
                { key: 'qty', label: 'จำนวน', render: (r) => num(r.qty) },
                { key: 'revenue', label: 'รายได้', render: (r) => baht(r.revenue) },
              ]}
            />
            <h3 style={{ marginTop: 20 }}>ออเดอร์ล่าสุด</h3>
            <DataTable
              rows={d.recent_orders}
              columns={[
                { key: 'Sale_No', label: 'เลขที่' },
                { key: 'Sale_Date', label: 'วันที่', render: (r) => thaiDate(r.Sale_Date) },
                { key: 'Total', label: 'ยอด', render: (r) => baht(r.Total) },
                { key: 'Payment_Method', label: 'ชำระ' },
                { key: 'Status', label: 'สถานะ', render: (r) => <Badge value={r.Status} /> },
              ]}
            />
          </>
        )}
      </StateView>
    </div>
  );
}
