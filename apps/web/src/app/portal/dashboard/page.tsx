'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Kpi, Card, StateView } from '@/components/ui';
import { baht, num } from '@/lib/format';

export default function PortalDashboard() {
  const q = useQuery<any>({ queryKey: ['portal-dashboard'], queryFn: () => api('/api/portal/dashboard') });
  const d = q.data;
  return (
    <div>
      <h1 style={{ marginTop: 0 }}>สวัสดี 👋 {d?.tenant ?? ''}</h1>
      <StateView q={q}>
        {d && (
          <>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
              <Kpi label="ยอดขายวันนี้" value={baht(d.today_sales)} accent="var(--navy)" />
              <Kpi label="บิลวันนี้" value={num(d.today_orders)} />
              <Kpi label="ยอดขายเดือนนี้" value={baht(d.mtd_sales)} />
              <Kpi label="คำสั่งซื้อค้าง" value={num(d.open_orders)} />
              <Kpi label="สินค้าใกล้หมด" value={num(d.low_stock_items)} accent="var(--ruby)" />
            </div>
            {d.auto_reorder && (
              <Card style={{ background: '#fffbeb', borderColor: '#fde68a' }}>
                🔔 ระบบสร้างใบสั่งซื้ออัตโนมัติ <strong>{d.auto_reorder.pending_no}</strong> ({d.auto_reorder.lines} รายการที่สต๊อกต่ำ) —
                ไปที่ <a href="/portal/inventory">สต๊อก &amp; สั่งซื้อ</a> เพื่อตรวจสอบและส่งอนุมัติ
              </Card>
            )}
          </>
        )}
      </StateView>
    </div>
  );
}
