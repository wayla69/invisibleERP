'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { api } from '@/lib/api';
import { DataTable, Badge, StateView } from '@/components/ui';
import { baht, thaiDate } from '@/lib/format';

export default function PosPage() {
  const q = useQuery<any>({ queryKey: ['orders'], queryFn: () => api('/api/pos/orders?limit=50') });
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ marginTop: 0 }}>🛒 ออเดอร์</h1>
        <Link href="/pos/new" className="btn" style={{ textDecoration: 'none' }}>+ สร้างออเดอร์</Link>
      </div>
      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={q.data.orders}
            columns={[
              { key: 'Sale_No', label: 'เลขที่' },
              { key: 'Sale_Date', label: 'วันที่', render: (r: any) => thaiDate(r.Sale_Date) },
              { key: 'Customer_Name', label: 'ลูกค้า' },
              { key: 'Total', label: 'ยอด', render: (r: any) => baht(r.Total) },
              { key: 'Payment_Method', label: 'ชำระ' },
              { key: 'Status', label: 'สถานะ', render: (r: any) => <Badge value={r.Status} /> },
            ]}
          />
        )}
      </StateView>
    </div>
  );
}
