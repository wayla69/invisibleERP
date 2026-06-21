'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { api } from '@/lib/api';
import { Kpi, Card, DataTable, StateView } from '@/components/ui';
import { baht, num, thaiDate } from '@/lib/format';

export default function StockDetailPage() {
  const { itemId } = useParams<{ itemId: string }>();
  const q = useQuery<any>({ queryKey: ['stock', itemId], queryFn: () => api(`/api/inventory/stock/${encodeURIComponent(itemId)}`) });
  const d = q.data;
  return (
    <div>
      <Link href="/inventory">← กลับ</Link>
      <h1 style={{ marginTop: 8 }}>{decodeURIComponent(itemId)}</h1>
      <StateView q={q}>
        {d && (
          <>
            <Card>
              <strong>{d.item.Item_Description}</strong>
              <div className="label">UOM {d.item.UOM} · คงเหลือ {num(d.item.AV_QTY)} · snapshot {thaiDate(d.snapshot_date)}</div>
            </Card>
            <div style={{ display: 'flex', gap: 12, margin: '12px 0' }}>
              <Kpi label="ยอดขาย 30 วัน" value={baht(d.sales_30d.total_revenue)} />
              <Kpi label="จำนวนขาย 30 วัน" value={num(d.sales_30d.total_qty)} />
              <Kpi label="ครั้งที่ขาย" value={num(d.sales_30d.sale_count)} />
            </div>
            <h3>ขายล่าสุด</h3>
            <DataTable
              rows={d.recent_sales}
              columns={[
                { key: 'Sale_No', label: 'เลขที่' },
                { key: 'Sale_Date', label: 'วันที่', render: (r: any) => thaiDate(r.Sale_Date) },
                { key: 'Customer_Name', label: 'ลูกค้า' },
                { key: 'Qty', label: 'จำนวน', render: (r: any) => num(r.Qty) },
                { key: 'Amount', label: 'ยอด', render: (r: any) => baht(r.Amount) },
              ]}
            />
            <h3 style={{ marginTop: 20 }}>การจัดซื้อล่าสุด</h3>
            <DataTable
              rows={d.recent_pos}
              columns={[
                { key: 'PO_No', label: 'PO' },
                { key: 'PO_Date', label: 'วันที่', render: (r: any) => thaiDate(r.PO_Date) },
                { key: 'Supplier_Name', label: 'ผู้ขาย' },
                { key: 'Order_Qty', label: 'สั่ง', render: (r: any) => num(r.Order_Qty) },
                { key: 'Received_Qty', label: 'รับ', render: (r: any) => num(r.Received_Qty) },
              ]}
            />
          </>
        )}
      </StateView>
    </div>
  );
}
