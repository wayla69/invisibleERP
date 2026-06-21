'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { DataTable, Badge, StateView } from '@/components/ui';
import { thaiDate } from '@/lib/format';

export default function PortalTrack() {
  const q = useQuery<any>({ queryKey: ['portal-track'], queryFn: () => api('/api/portal/track') });
  return (
    <div>
      <h1 style={{ marginTop: 0 }}>📮 ติดตามคำสั่งซื้อ</h1>
      <StateView q={q}>
        {q.data && (
          <DataTable rows={q.data.orders} columns={[
            { key: 'order_no', label: 'เลขที่' },
            { key: 'order_date', label: 'วันที่สั่ง', render: (r) => thaiDate(r.order_date) },
            { key: 'display_status', label: 'สถานะ', render: (r) => <Badge value={r.display_status} /> },
            { key: 'estimated_delivery', label: 'กำหนดส่ง', render: (r) => (r.estimated_delivery ? thaiDate(r.estimated_delivery) : '—') },
          ]} />
        )}
      </StateView>
    </div>
  );
}
