'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { thaiDate } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { statusVariant } from '@/components/ui';

export default function PortalTrack() {
  const q = useQuery<any>({ queryKey: ['portal-track'], queryFn: () => api('/api/portal/track') });
  return (
    <div>
      <PageHeader title="ติดตามคำสั่งซื้อ" description="สถานะและกำหนดส่งของคำสั่งซื้อ" />
      <StateView q={q}>
        {q.data && (
          <DataTable rows={q.data.orders} columns={[
            { key: 'order_no', label: 'เลขที่' },
            { key: 'order_date', label: 'วันที่สั่ง', render: (r) => thaiDate(r.order_date) },
            { key: 'display_status', label: 'สถานะ', render: (r) => <Badge variant={statusVariant(r.display_status)}>{r.display_status}</Badge> },
            { key: 'estimated_delivery', label: 'กำหนดส่ง', render: (r) => (r.estimated_delivery ? thaiDate(r.estimated_delivery) : '—') },
          ]} />
        )}
      </StateView>
    </div>
  );
}
