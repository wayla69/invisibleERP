'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { baht, thaiDate } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { statusVariant } from '@/components/ui';
import { ProcurementForms } from '@/components/procurement-forms';

const PO_LIST_KEY = ['proc-pos'];

export default function ProcurementPage() {
  const pos = useQuery<any>({ queryKey: PO_LIST_KEY, queryFn: () => api('/api/inventory/purchase-orders?limit=50') });

  return (
    <div>
      <PageHeader title="จัดซื้อ (Procurement)" description="สร้าง PR / PO / รับสินค้า (GR) และติดตามสถานะ" />

      <Card className="mb-6 gap-4">
        <CardHeader>
          <CardTitle className="text-base">รายการจัดซื้อ (PR → PO → GR)</CardTitle>
        </CardHeader>
        <CardContent>
          <ProcurementForms poListQueryKey={PO_LIST_KEY} />
        </CardContent>
      </Card>

      <h3 className="mb-3 text-sm font-semibold text-muted-foreground">ใบสั่งซื้อ</h3>
      <StateView q={pos}>
        {pos.data && (
          <DataTable
            rows={pos.data.purchase_orders}
            columns={[
              { key: 'PO_No', label: 'PO' },
              { key: 'PO_Date', label: 'วันที่', render: (r: any) => thaiDate(r.PO_Date) },
              { key: 'Supplier_Name', label: 'ผู้ขาย' },
              { key: 'Total_Amount', label: 'ยอด', align: 'right', render: (r: any) => baht(r.Total_Amount) },
              { key: 'Status', label: 'สถานะ', render: (r: any) => <Badge variant={statusVariant(r.Status)}>{r.Status}</Badge> },
            ]}
          />
        )}
      </StateView>
    </div>
  );
}
