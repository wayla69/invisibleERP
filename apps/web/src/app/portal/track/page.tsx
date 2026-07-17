'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { thaiDate } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { statusVariant } from '@/components/ui';

export default function PortalTrack() {
  const { t } = useLang();
  const q = useQuery<any>({ queryKey: ['portal-track'], queryFn: () => api('/api/portal/track') });
  return (
    <div>
      <PageHeader title={t('pt.trk.title')} description={t('pt.trk.desc')} />
      <StateView q={q}>
        {q.data && (
          <DataTable rows={q.data.orders} columns={[
            { key: 'order_no', label: t('pt.col_no') },
            { key: 'order_date', label: t('pt.trk.col_order_date'), render: (r) => thaiDate(r.order_date) },
            { key: 'display_status', label: t('pt.col_status'), render: (r) => <Badge variant={statusVariant(r.display_status)}>{r.display_status}</Badge> },
            { key: 'estimated_delivery', label: t('pt.trk.col_eta'), render: (r) => (r.estimated_delivery ? thaiDate(r.estimated_delivery) : '—') },
          ]} />
        )}
      </StateView>
    </div>
  );
}
