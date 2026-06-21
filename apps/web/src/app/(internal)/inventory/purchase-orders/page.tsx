'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { DataTable, Badge, StateView } from '@/components/ui';
import { baht, thaiDate } from '@/lib/format';

export default function PurchaseOrdersPage() {
  const q = useQuery<any>({ queryKey: ['pos'], queryFn: () => api('/api/inventory/purchase-orders?limit=50') });
  return (
    <div>
      <h1 style={{ marginTop: 0 }}>🧾 ใบสั่งซื้อ (PO)</h1>
      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={q.data.purchase_orders}
            columns={[
              { key: 'PO_No', label: 'PO' },
              { key: 'PO_Date', label: 'วันที่', render: (r: any) => thaiDate(r.PO_Date) },
              { key: 'Supplier_Name', label: 'ผู้ขาย' },
              { key: 'Total_Amount', label: 'ยอด', render: (r: any) => baht(r.Total_Amount) },
              { key: 'Status', label: 'สถานะ', render: (r: any) => <Badge value={r.Status} /> },
            ]}
          />
        )}
      </StateView>
    </div>
  );
}
