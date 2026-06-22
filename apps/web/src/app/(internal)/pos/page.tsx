'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, thaiDate } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { statusVariant } from '@/components/ui';

export default function PosPage() {
  const q = useQuery<any>({ queryKey: ['orders'], queryFn: () => api('/api/pos/orders?limit=50') });
  return (
    <div>
      <PageHeader
        title="ออเดอร์"
        description="รายการขายและสถานะการชำระเงิน"
        actions={
          <Button asChild>
            <Link href="/pos/new">
              <Plus className="size-4" /> สร้างออเดอร์
            </Link>
          </Button>
        }
      />
      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={q.data.orders}
            columns={[
              { key: 'Sale_No', label: 'เลขที่' },
              { key: 'Sale_Date', label: 'วันที่', render: (r: any) => thaiDate(r.Sale_Date) },
              { key: 'Customer_Name', label: 'ลูกค้า' },
              { key: 'Total', label: 'ยอด', align: 'right', render: (r: any) => baht(r.Total) },
              { key: 'Payment_Method', label: 'ชำระ' },
              { key: 'Status', label: 'สถานะ', render: (r: any) => <Badge variant={statusVariant(r.Status)}>{r.Status}</Badge> },
            ]}
          />
        )}
      </StateView>
    </div>
  );
}
