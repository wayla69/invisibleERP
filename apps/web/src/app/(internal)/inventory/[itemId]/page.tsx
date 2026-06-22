'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Banknote, Hash, ShoppingBag } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num, thaiDate } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export default function StockDetailPage() {
  const { itemId } = useParams<{ itemId: string }>();
  const q = useQuery<any>({ queryKey: ['stock', itemId], queryFn: () => api(`/api/inventory/stock/${encodeURIComponent(itemId)}`) });
  const d = q.data;
  return (
    <div>
      <PageHeader
        title={decodeURIComponent(itemId)}
        description="รายละเอียดสินค้าและประวัติการเคลื่อนไหว"
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/inventory">
              <ArrowLeft className="size-4" /> กลับ
            </Link>
          </Button>
        }
      />
      <StateView q={q}>
        {d && (
          <div className="space-y-6">
            <Card>
              <CardContent>
                <p className="font-semibold">{d.item.Item_Description}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  UOM {d.item.UOM} · คงเหลือ {num(d.item.AV_QTY)} · snapshot {thaiDate(d.snapshot_date)}
                </p>
              </CardContent>
            </Card>

            <div className="grid gap-4 sm:grid-cols-3">
              <StatCard label="ยอดขาย 30 วัน" value={baht(d.sales_30d.total_revenue)} icon={Banknote} tone="primary" />
              <StatCard label="จำนวนขาย 30 วัน" value={num(d.sales_30d.total_qty)} icon={ShoppingBag} />
              <StatCard label="ครั้งที่ขาย" value={num(d.sales_30d.sale_count)} icon={Hash} />
            </div>

            <div>
              <h3 className="mb-3 text-sm font-semibold text-muted-foreground">ขายล่าสุด</h3>
              <DataTable
                rows={d.recent_sales}
                columns={[
                  { key: 'Sale_No', label: 'เลขที่' },
                  { key: 'Sale_Date', label: 'วันที่', render: (r: any) => thaiDate(r.Sale_Date) },
                  { key: 'Customer_Name', label: 'ลูกค้า' },
                  { key: 'Qty', label: 'จำนวน', align: 'right', render: (r: any) => num(r.Qty) },
                  { key: 'Amount', label: 'ยอด', align: 'right', render: (r: any) => baht(r.Amount) },
                ]}
              />
            </div>

            <div>
              <h3 className="mb-3 text-sm font-semibold text-muted-foreground">การจัดซื้อล่าสุด</h3>
              <DataTable
                rows={d.recent_pos}
                columns={[
                  { key: 'PO_No', label: 'PO' },
                  { key: 'PO_Date', label: 'วันที่', render: (r: any) => thaiDate(r.PO_Date) },
                  { key: 'Supplier_Name', label: 'ผู้ขาย' },
                  { key: 'Order_Qty', label: 'สั่ง', align: 'right', render: (r: any) => num(r.Order_Qty) },
                  { key: 'Received_Qty', label: 'รับ', align: 'right', render: (r: any) => num(r.Received_Qty) },
                ]}
              />
            </div>
          </div>
        )}
      </StateView>
    </div>
  );
}
