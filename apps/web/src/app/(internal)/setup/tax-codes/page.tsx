'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Coins, Plus, Save, X } from 'lucide-react';
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { MasterIo } from '@/components/master-io';

type Tax = {
  code: string; name?: string; name_th?: string; kind?: 'vat' | 'wht'; rate?: number;
  output_account?: string; input_account?: string; wht_account?: string; wht_income_type?: string;
  inclusive?: boolean; active?: boolean;
};
const BLANK: Tax = { code: '', kind: 'vat', rate: 0, active: true };

// รหัสภาษี — VAT + WHT tax-code master (rate + GL accounts). The configurable tax surface behind item posting
// determination (docs/33, GL-21) replacing the single tenant vat_rate column.
export default function TaxCodesPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['tax-codes'], queryFn: () => api('/api/item-setup/tax-codes') });
  const [form, setForm] = useState<Tax>(BLANK);
  const [ratePct, setRatePct] = useState('0');
  const [editing, setEditing] = useState(false);
  const set = (k: keyof Tax) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const reset = () => { setForm(BLANK); setRatePct('0'); setEditing(false); };
  const payload = () => {
    const p: any = { code: form.code.trim(), kind: form.kind, rate: (Number(ratePct) || 0) / 100 };
    for (const k of ['name', 'name_th', 'output_account', 'input_account', 'wht_account', 'wht_income_type'] as const) p[k] = (form as any)[k] ? (form as any)[k] : null;
    p.inclusive = !!form.inclusive; p.active = form.active !== false; return p;
  };
  const save = useMutation({
    mutationFn: () => editing
      ? api(`/api/item-setup/tax-codes/${encodeURIComponent(form.code.trim())}`, { method: 'PATCH', body: JSON.stringify(payload()) })
      : api('/api/item-setup/tax-codes', { method: 'POST', body: JSON.stringify(payload()) }),
    onSuccess: (r: any) => { notifySuccess(t('st.stax_saved', { code: r.code })); reset(); qc.invalidateQueries({ queryKey: ['tax-codes'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  const edit = (t: Tax) => { setForm({ ...BLANK, ...t }); setRatePct(String(((t.rate ?? 0) * 100).toFixed(2)).replace(/\.00$/, '')); setEditing(true); };

  return (
    <div>
      <PageHeader title={t('st.stax_title')} description={t('st.stax_desc')} />
      <div className="space-y-5">
        <Card className="max-w-4xl gap-4 p-5">
          <h3 className="text-base font-semibold">{editing ? t('st.stax_edit_heading', { code: form.code }) : t('st.stax_add_heading')}</h3>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label={t('st.stax_code')}><Input value={form.code} onChange={set('code')} disabled={editing} placeholder={t('st.stax_ph_code')} /></Field>
            <Field label={t('st.stax_kind')}>
              <Select value={form.kind} onValueChange={(v) => setForm((f) => ({ ...f, kind: v as 'vat' | 'wht' }))}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="vat">{t('st.stax_kind_vat')}</SelectItem>
                  <SelectItem value="wht">{t('st.stax_kind_wht')}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label={t('st.stax_rate')}><Input type="number" value={ratePct} onChange={(e) => setRatePct(e.target.value)} placeholder="7" /></Field>
            <Field label={t('st.stax_name_en')}><Input value={form.name ?? ''} onChange={set('name')} placeholder="VAT 7%" /></Field>
            <Field label={t('st.stax_name_th')}><Input value={form.name_th ?? ''} onChange={set('name_th')} placeholder={t('st.stax_ph_name_th')} /></Field>
            {form.kind === 'vat' ? (
              <>
                <Field label={t('st.stax_output')}><Input value={form.output_account ?? ''} onChange={set('output_account')} placeholder="2100" /></Field>
                <Field label={t('st.stax_input')}><Input value={form.input_account ?? ''} onChange={set('input_account')} placeholder="2100" /></Field>
              </>
            ) : (
              <>
                <Field label={t('st.stax_wht_account')}><Input value={form.wht_account ?? ''} onChange={set('wht_account')} placeholder="2361" /></Field>
                <Field label={t('st.stax_income_type')}><Input value={form.wht_income_type ?? ''} onChange={set('wht_income_type')} placeholder={t('st.stax_ph_wht')} /></Field>
              </>
            )}
          </div>
          <div className="flex gap-2">
            <Button disabled={save.isPending || !form.code.trim()} onClick={() => save.mutate()}>
              {editing ? <Save className="size-4" /> : <Plus className="size-4" />} {save.isPending ? t('st.stax_saving') : editing ? t('st.stax_save_edit') : t('st.stax_add')}
            </Button>
            {editing && <Button variant="outline" onClick={reset}><X className="size-4" /> {t('st.stax_cancel')}</Button>}
          </div>
        </Card>

        <StateView q={q}>
          {q.data && (
            <div className="space-y-5">
              <StatCard label={t('st.stax_stat_count')} value={q.data.count ?? 0} icon={Coins} tone="primary" className="max-w-xs" />
              <DataTable
                rows={q.data.tax_codes ?? []}
                rowKey={(r: Tax) => r.code}
                onRowClick={(r: Tax) => edit(r)}
                columns={[
                  { key: 'code', label: t('st.stax_code') },
                  { key: 'kind', label: t('st.stax_col_kind'), render: (r: Tax) => <Badge variant={r.kind === 'wht' ? 'warning' : 'success'}>{r.kind === 'wht' ? t('st.stax_wht_short') : 'VAT'}</Badge> },
                  { key: 'rate', label: t('st.stax_col_rate'), align: 'right', render: (r: Tax) => `${((r.rate ?? 0) * 100).toFixed(2).replace(/\.00$/, '')}%` },
                  { key: 'name', label: t('st.stax_col_name'), render: (r: Tax) => r.name_th || r.name || '—' },
                  { key: 'acct', label: t('st.stax_col_account'), sortable: false, render: (r: Tax) => r.kind === 'wht' ? (r.wht_account ?? '—') : `${r.output_account ?? '—'} / ${r.input_account ?? '—'}` },
                  { key: 'active', label: t('st.stax_col_status'), render: (r: Tax) => <Badge variant={r.active === false ? 'destructive' : 'success'}>{r.active === false ? t('st.stax_off') : t('st.stax_active')}</Badge> },
                ]}
                emptyState={{ icon: Coins, title: t('st.stax_empty_title'), description: t('st.stax_empty_desc') }}
              />
            </div>
          )}
        </StateView>

        <MasterIo entityKey="tax_codes" base="item-setup" onImported={() => qc.invalidateQueries({ queryKey: ['tax-codes'] })} />
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="grid gap-2"><Label>{label}</Label>{children}</div>;
}
