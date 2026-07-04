'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Warehouse, Save, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';

type Wh = { location_id: string; location_name?: string; zone?: string; active?: boolean; inventory_account?: string; adjustment_account?: string };

// คลังสินค้า — warehouse account defaults (docs/33 PR5, GL-21). The lowest tier of item-posting determination:
// an item's inventory/adjustment account falls through item → its category → THIS warehouse → the control account.
export default function WarehouseAccountsPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['setup-warehouses'], queryFn: () => api('/api/item-setup/warehouses') });
  const [editing, setEditing] = useState<string | null>(null);
  const [inv, setInv] = useState('');
  const [adj, setAdj] = useState('');

  const start = (w: Wh) => { setEditing(w.location_id); setInv(w.inventory_account ?? ''); setAdj(w.adjustment_account ?? ''); };
  const cancel = () => { setEditing(null); setInv(''); setAdj(''); };
  const save = useMutation({
    mutationFn: () => api(`/api/item-setup/warehouses/${encodeURIComponent(editing!)}`, { method: 'PATCH', body: JSON.stringify({ inventory_account: inv.trim() || null, adjustment_account: adj.trim() || null }) }),
    onSuccess: (r: any) => { notifySuccess(t('st.swh_saved', { location_id: r.location_id })); cancel(); qc.invalidateQueries({ queryKey: ['setup-warehouses'] }); },
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <div>
      <PageHeader title={t('st.swh_title')} description={t('st.swh_desc')} />
      <StateView q={q}>
        {q.data && (
          <div className="space-y-5">
            <StatCard label={t('st.swh_stat_count')} value={q.data.count ?? 0} icon={Warehouse} tone="primary" className="max-w-xs" />
            <DataTable
              rows={q.data.warehouses ?? []}
              rowKey={(r: Wh) => r.location_id}
              columns={[
                { key: 'location_id', label: t('st.swh_col_id') },
                { key: 'location_name', label: t('st.swh_col_name'), render: (r: Wh) => r.location_name ?? '—' },
                { key: 'zone', label: t('st.swh_col_zone'), render: (r: Wh) => r.zone ?? '—' },
                {
                  key: 'inventory_account', label: t('st.swh_col_inventory'), sortable: false,
                  render: (r: Wh) => editing === r.location_id
                    ? <Input value={inv} onChange={(e) => setInv(e.target.value)} placeholder="1200" className="h-8 w-28" />
                    : (r.inventory_account ?? '—'),
                },
                {
                  key: 'adjustment_account', label: t('st.swh_col_adjustment'), sortable: false,
                  render: (r: Wh) => editing === r.location_id
                    ? <Input value={adj} onChange={(e) => setAdj(e.target.value)} placeholder="5810" className="h-8 w-28" />
                    : (r.adjustment_account ?? '—'),
                },
                { key: 'active', label: t('st.swh_col_status'), render: (r: Wh) => <Badge variant={r.active === false ? 'destructive' : 'success'}>{r.active === false ? t('st.swh_off') : t('st.swh_active')}</Badge> },
                {
                  key: 'actions', label: '', sortable: false,
                  render: (r: Wh) => editing === r.location_id
                    ? <div className="flex gap-1">
                        <Button size="sm" disabled={save.isPending} onClick={() => save.mutate()}><Save className="size-4" /></Button>
                        <Button size="sm" variant="outline" onClick={cancel}><X className="size-4" /></Button>
                      </div>
                    : <Button size="sm" variant="outline" onClick={() => start(r)}>{t('st.swh_edit')}</Button>,
                },
              ]}
              emptyState={{ icon: Warehouse, title: t('st.swh_empty_title'), description: t('st.swh_empty_desc') }}
            />
          </div>
        )}
      </StateView>
    </div>
  );
}
