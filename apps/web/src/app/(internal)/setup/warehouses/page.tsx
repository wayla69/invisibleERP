'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Warehouse, Pencil } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { FormField } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

type Wh = {
  location_id: string; location_name?: string | null; zone?: string | null; type?: string | null;
  capacity?: number | null; temperature?: string | null; active?: boolean; notes?: string | null;
  inventory_account?: string | null; adjustment_account?: string | null;
};

// คลังสินค้า — warehouse master + account defaults (docs/33 PR5, GL-21). The lowest tier of item-posting
// determination: an item's inventory/adjustment account falls through item → its category → THIS warehouse
// → the control account. Name/zone/type/capacity/temperature/status were previously read-only here (master-
// data audit Phase 2) — now editable via the same form.
export default function WarehouseAccountsPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['setup-warehouses'], queryFn: () => api('/api/item-setup/warehouses') });
  const [editing, setEditing] = useState<Wh | null>(null);

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
                { key: 'type', label: t('st.swh_col_type'), render: (r: Wh) => r.type ?? '—' },
                { key: 'temperature', label: t('st.swh_col_temperature'), render: (r: Wh) => r.temperature ?? '—' },
                { key: 'inventory_account', label: t('st.swh_col_inventory'), render: (r: Wh) => r.inventory_account ?? '—' },
                { key: 'adjustment_account', label: t('st.swh_col_adjustment'), render: (r: Wh) => r.adjustment_account ?? '—' },
                { key: 'active', label: t('st.swh_col_status'), render: (r: Wh) => <Badge variant={r.active === false ? 'destructive' : 'success'}>{r.active === false ? t('st.swh_off') : t('st.swh_active')}</Badge> },
                {
                  key: 'actions', label: '', sortable: false,
                  render: (r: Wh) => <Button size="sm" variant="outline" onClick={() => setEditing(r)}><Pencil className="size-4" /> {t('st.swh_edit')}</Button>,
                },
              ]}
              emptyState={{ icon: Warehouse, title: t('st.swh_empty_title'), description: t('st.swh_empty_desc') }}
            />
          </div>
        )}
      </StateView>
      {editing && <EditDialog warehouse={editing} onClose={() => setEditing(null)} onSaved={() => qc.invalidateQueries({ queryKey: ['setup-warehouses'] })} />}
    </div>
  );
}

function EditDialog({ warehouse, onClose, onSaved }: { warehouse: Wh; onClose: () => void; onSaved: () => void }) {
  const { t } = useLang();
  const [form, setForm] = useState<Wh>({ ...warehouse });
  const set = (k: keyof Wh) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = useMutation({
    mutationFn: () => api<Wh>(`/api/item-setup/warehouses/${encodeURIComponent(warehouse.location_id)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        location_name: form.location_name?.trim() || null, zone: form.zone?.trim() || null, type: form.type?.trim() || null,
        capacity: form.capacity != null && String(form.capacity) !== '' ? Number(form.capacity) : null,
        temperature: form.temperature?.trim() || null, active: form.active !== false, notes: form.notes?.trim() || null,
        inventory_account: form.inventory_account?.trim() || null, adjustment_account: form.adjustment_account?.trim() || null,
      }),
    }),
    onSuccess: (r) => { notifySuccess(t('st.swh_saved', { location_id: r.location_id })); onSaved(); onClose(); },
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{warehouse.location_id}</DialogTitle>
          <DialogDescription>{t('st.swh_desc')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label={t('st.swh_col_name')}><Input value={form.location_name ?? ''} onChange={set('location_name')} /></FormField>
          <FormField label={t('st.swh_col_zone')}><Input value={form.zone ?? ''} onChange={set('zone')} /></FormField>
          <FormField label={t('st.swh_col_type')}><Input value={form.type ?? ''} onChange={set('type')} /></FormField>
          <FormField label={t('st.swh_col_capacity')}><Input type="number" min="0" step="any" value={form.capacity ?? ''} onChange={(e) => setForm((f) => ({ ...f, capacity: e.target.value === '' ? null : Number(e.target.value) }))} /></FormField>
          <FormField label={t('st.swh_col_temperature')}><Input value={form.temperature ?? ''} onChange={set('temperature')} /></FormField>
          <FormField label={t('st.swh_col_status')}>
            <Select value={form.active === false ? '0' : '1'} onValueChange={(v) => setForm((f) => ({ ...f, active: v === '1' }))}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="1">{t('st.swh_active')}</SelectItem>
                <SelectItem value="0">{t('st.swh_off')}</SelectItem>
              </SelectContent>
            </Select>
          </FormField>
          <FormField label={t('st.swh_col_inventory')}><Input value={form.inventory_account ?? ''} onChange={set('inventory_account')} placeholder="1200" /></FormField>
          <FormField label={t('st.swh_col_adjustment')}><Input value={form.adjustment_account ?? ''} onChange={set('adjustment_account')} placeholder="5810" /></FormField>
          <FormField label={t('st.swh_col_notes')} className="sm:col-span-2"><Input value={form.notes ?? ''} onChange={set('notes')} /></FormField>
        </div>
        <DialogFooter>
          <Button disabled={save.isPending} onClick={() => save.mutate()}>{t('st.swh_save_btn')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
