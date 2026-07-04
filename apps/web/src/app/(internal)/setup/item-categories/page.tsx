'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Layers, Plus, Save, X } from 'lucide-react';
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

type Cat = {
  code: string; name?: string; name_th?: string;
  revenue_account?: string; cogs_account?: string; inventory_account?: string; valuation_account?: string;
  vat_code?: string; wht_income_type?: string; default_location_id?: string; active?: boolean;
};
const BLANK: Cat = { code: '', active: true };

// หมวดสินค้า — item category master carrying the default GL account-set + tax profile a family of items posts
// to (docs/33, GL-21). The posting engine resolves item → this category → the standard control account.
export default function ItemCategoriesPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['item-categories'], queryFn: () => api('/api/item-setup/categories') });
  const [form, setForm] = useState<Cat>(BLANK);
  const [editing, setEditing] = useState(false);
  const set = (k: keyof Cat) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const reset = () => { setForm(BLANK); setEditing(false); };
  const payload = () => {
    const p: any = {}; for (const [k, v] of Object.entries(form)) p[k] = v === '' ? null : v; p.code = form.code.trim(); return p;
  };
  const save = useMutation({
    mutationFn: () => editing
      ? api(`/api/item-setup/categories/${encodeURIComponent(form.code.trim())}`, { method: 'PATCH', body: JSON.stringify(payload()) })
      : api('/api/item-setup/categories', { method: 'POST', body: JSON.stringify(payload()) }),
    onSuccess: (r: any) => { notifySuccess(t('st.scat_saved', { code: r.code })); reset(); qc.invalidateQueries({ queryKey: ['item-categories'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  const edit = (c: Cat) => { setForm({ ...BLANK, ...c }); setEditing(true); };

  return (
    <div>
      <PageHeader title={t('st.scat_title')} description={t('st.scat_desc')} />
      <div className="space-y-5">
        <Card className="max-w-4xl gap-4 p-5">
          <h3 className="text-base font-semibold">{editing ? t('st.scat_edit_heading', { code: form.code }) : t('st.scat_add_heading')}</h3>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label={t('st.scat_code')}><Input value={form.code} onChange={set('code')} disabled={editing} placeholder={t('st.scat_ph_code')} /></Field>
            <Field label={t('st.scat_name_en')}><Input value={form.name ?? ''} onChange={set('name')} placeholder="Beverages" /></Field>
            <Field label={t('st.scat_name_th')}><Input value={form.name_th ?? ''} onChange={set('name_th')} placeholder={t('st.scat_ph_name_th')} /></Field>
            <Field label={t('st.scat_revenue')}><Input value={form.revenue_account ?? ''} onChange={set('revenue_account')} placeholder="4000" /></Field>
            <Field label={t('st.scat_cogs')}><Input value={form.cogs_account ?? ''} onChange={set('cogs_account')} placeholder="5000" /></Field>
            <Field label={t('st.scat_inventory')}><Input value={form.inventory_account ?? ''} onChange={set('inventory_account')} placeholder="1200" /></Field>
            <Field label={t('st.scat_valuation')}><Input value={form.valuation_account ?? ''} onChange={set('valuation_account')} placeholder={t('st.scat_ph_optional')} /></Field>
            <Field label={t('st.scat_vat')}><Input value={form.vat_code ?? ''} onChange={set('vat_code')} placeholder="VAT7" /></Field>
            <Field label={t('st.scat_wht')}><Input value={form.wht_income_type ?? ''} onChange={set('wht_income_type')} placeholder={t('st.scat_ph_wht')} /></Field>
            <Field label={t('st.scat_location')}><Input value={form.default_location_id ?? ''} onChange={set('default_location_id')} placeholder="WH-MAIN" /></Field>
          </div>
          <div className="flex gap-2">
            <Button disabled={save.isPending || !form.code.trim()} onClick={() => save.mutate()}>
              {editing ? <Save className="size-4" /> : <Plus className="size-4" />} {save.isPending ? t('st.scat_saving') : editing ? t('st.scat_save_edit') : t('st.scat_add')}
            </Button>
            {editing && <Button variant="outline" onClick={reset}><X className="size-4" /> {t('st.scat_cancel')}</Button>}
          </div>
        </Card>

        <StateView q={q}>
          {q.data && (
            <div className="space-y-5">
              <StatCard label={t('st.scat_stat_count')} value={q.data.count ?? 0} icon={Layers} tone="primary" className="max-w-xs" />
              <DataTable
                rows={q.data.categories ?? []}
                rowKey={(r: Cat) => r.code}
                onRowClick={(r: Cat) => edit(r)}
                columns={[
                  { key: 'code', label: t('st.scat_code') },
                  { key: 'name', label: t('st.scat_col_name'), render: (r: Cat) => r.name_th || r.name || '—' },
                  { key: 'revenue_account', label: t('st.scat_col_revenue'), render: (r: Cat) => r.revenue_account ?? '—' },
                  { key: 'cogs_account', label: t('st.scat_col_cogs'), render: (r: Cat) => r.cogs_account ?? '—' },
                  { key: 'inventory_account', label: t('st.scat_col_inventory'), render: (r: Cat) => r.inventory_account ?? '—' },
                  { key: 'vat_code', label: 'VAT', render: (r: Cat) => r.vat_code ?? '—' },
                  { key: 'active', label: t('st.scat_col_status'), render: (r: Cat) => <Badge variant={r.active === false ? 'destructive' : 'success'}>{r.active === false ? t('st.scat_off') : t('st.scat_active')}</Badge> },
                ]}
                emptyState={{ icon: Layers, title: t('st.scat_empty_title'), description: t('st.scat_empty_desc') }}
              />
            </div>
          )}
        </StateView>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="grid gap-2"><Label>{label}</Label>{children}</div>;
}
