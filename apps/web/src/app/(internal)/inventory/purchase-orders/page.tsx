'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { baht, thaiDate } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { statusVariant } from '@/components/ui';

export default function PurchaseOrdersPage() {
  const q = useQuery<any>({ queryKey: ['pos'], queryFn: () => api('/api/inventory/purchase-orders?limit=50') });
  return (
    <div>
      <PageHeader title="ใบสั่งซื้อ (PO)" description="รายการใบสั่งซื้อและสถานะ" />
      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={q.data.purchase_orders}
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
